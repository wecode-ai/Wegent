// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `python-pptx`-equivalent `.pptx` slide text extraction
//! (`DocumentParser._parse_powerpoint` / `_parse_powerpoint_smart`).
//!
//! The source iterates `prs.slides` in `p:sldIdLst` order (each `r:id`
//! resolved through `ppt/_rels/presentation.xml.rels`), then, per slide,
//! every `p:spTree` child in document order:
//!
//! - a `p:sp` (`Shape`, including placeholders) contributes its
//!   `txBody.text` when non-blank: paragraphs joined with `\n`, a paragraph
//!   being its `a:r`/`a:fld` text with one `\v` per `a:br`;
//! - a `p:graphicFrame` whose `a:graphicData` is the DrawingML table URI
//!   contributes one `" | "`-joined line per populated table row (`pptx`
//!   iterates the row's `a:tc` cells directly, unlike `python-docx`'s
//!   grid-span model);
//! - `p:pic`, `p:grpSp`, and `p:cxnSp` carry no `text` attribute and never
//!   contribute.
//!
//! A slide with at least one content line renders as
//! `--- Slide {n} ---` (the `sldIdLst` position) followed by those lines;
//! blank slides drop out of `slides_text`.
use super::OfficeError;
use super::xml::{Element, Tree};
use super::zip::ZipArchive;

/// The extracted slide texts, before the smart-truncation pass.
pub(crate) struct PowerPointText {
    pub slides: Vec<String>,
}

/// Extract the slide texts from a `.pptx` package.
pub(crate) fn extract(data: &[u8]) -> Result<PowerPointText, OfficeError> {
    let archive = ZipArchive::new(data).map_err(|_| OfficeError)?;
    let presentation = archive
        .read("ppt/presentation.xml")
        .map_err(|_| OfficeError)?;
    let presentation = std::str::from_utf8(&presentation).map_err(|_| OfficeError)?;
    let rels = archive
        .read("ppt/_rels/presentation.xml.rels")
        .map_err(|_| OfficeError)?;
    let rels = std::str::from_utf8(&rels).map_err(|_| OfficeError)?;

    let slide_ids = presentation_slide_ids(presentation)?;
    let targets = slide_relationship_targets(rels)?;
    let mut slides = Vec::new();
    for (position, relation_id) in slide_ids.iter().enumerate() {
        // `prs.slides` resolves each `sldIdLst` entry's `r:id` to its part;
        // an unresolvable id raises, which the caller reports as
        // `parse_failed`.
        let target = targets
            .iter()
            .find(|(id, _)| id == relation_id)
            .map(|(_, target)| target.clone())
            .ok_or(OfficeError)?;
        let part_name = format!("ppt/{target}");
        let slide = archive.read(&part_name).map_err(|_| OfficeError)?;
        let slide = std::str::from_utf8(&slide).map_err(|_| OfficeError)?;
        if let Some(rendered) = slide_text(slide, position + 1)? {
            slides.push(rendered);
        }
    }
    Ok(PowerPointText { slides })
}

/// The `p:sldIdLst` `r:id` values in presentation order.
fn presentation_slide_ids(presentation: &str) -> Result<Vec<String>, OfficeError> {
    let document = Tree::new(presentation)
        .find_element("presentation")
        .map_err(|_| OfficeError)?
        .ok_or(OfficeError)?;
    let Some(slide_list) = document.child("sldIdLst") else {
        return Ok(Vec::new());
    };
    Ok(slide_list
        .named_children("sldId")
        .filter_map(|slide_id| slide_id.attr("r:id").map(str::to_string))
        .collect())
}

/// The `Relationship` entries whose type is the slide relationship.
fn slide_relationship_targets(rels: &str) -> Result<Vec<(String, String)>, OfficeError> {
    let relationships = Tree::new(rels)
        .find_element("Relationships")
        .map_err(|_| OfficeError)?
        .ok_or(OfficeError)?;
    let mut targets = Vec::new();
    for relationship in relationships.named_children("Relationship") {
        let Some(relationship_type) = relationship.attr_local("Type") else {
            continue;
        };
        if !relationship_type.ends_with("/slide") {
            continue;
        }
        if let (Some(id), Some(target)) = (
            relationship.attr_local("Id"),
            relationship.attr_local("Target"),
        ) {
            // External parts cannot be read from the package.
            if relationship.attr_local("TargetMode").is_none() {
                targets.push((id.to_string(), target.to_string()));
            }
        }
    }
    Ok(targets)
}

/// One rendered slide: `--- Slide {n} ---` plus its content lines, or `None`
/// for a slide without content (the source drops it from `slides_text`).
fn slide_text(slide: &str, number: usize) -> Result<Option<String>, OfficeError> {
    let document = Tree::new(slide)
        .find_element("sld")
        .map_err(|_| OfficeError)?
        .ok_or(OfficeError)?;
    let tree = document
        .child("cSld")
        .and_then(|child| child.child("spTree"))
        .ok_or(OfficeError)?;

    let mut lines: Vec<String> = Vec::new();
    for shape in &tree.children {
        match shape.local() {
            "sp" => {
                let text = shape_text(shape);
                if !text.trim().is_empty() {
                    lines.push(text);
                }
            }
            "graphicFrame" if is_table_graphic_frame(shape) => {
                lines.extend(table_rows(shape));
            }
            _ => {}
        }
    }
    Ok(if lines.is_empty() {
        None
    } else {
        lines.insert(0, format!("--- Slide {number} ---"));
        Some(lines.join("\n"))
    })
}

/// `Shape.text`: the `txBody` paragraphs joined with `\n` (`TextFrame.text`).
fn shape_text(shape: &Element) -> String {
    let Some(body) = shape.child("txBody") else {
        return String::new();
    };
    body.named_children("p")
        .map(paragraph_text)
        .collect::<Vec<_>>()
        .join("\n")
}

/// `_Paragraph.text`: the `a:r`/`a:fld` text plus one `\v` per `a:br`, in
/// document order.
fn paragraph_text(paragraph: &Element) -> String {
    let mut text = String::new();
    for child in &paragraph.children {
        match child.local() {
            "r" | "fld" => {
                if let Some(element) = child.child("t") {
                    text.push_str(&element.direct_text());
                }
            }
            "br" => text.push('\u{0b}'),
            _ => {}
        }
    }
    text
}

/// `GraphicFrame.has_table`: the `a:graphicData` URI is the DrawingML table.
fn is_table_graphic_frame(frame: &Element) -> bool {
    frame
        .child("graphic")
        .and_then(|graphic| graphic.child("graphicData"))
        .and_then(|data| data.attr_local("uri"))
        .is_some_and(|uri| uri == "http://schemas.openxmlformats.org/drawingml/2006/table")
}

/// One `" | "`-joined line per table row with populated cells
/// (`_Row.cells` iterates the row's `a:tc` elements directly).
fn table_rows(frame: &Element) -> Vec<String> {
    let Some(table) = frame
        .child("graphic")
        .and_then(|graphic| graphic.child("graphicData"))
        .and_then(|data| data.child("tbl"))
    else {
        return Vec::new();
    };
    let mut rows = Vec::new();
    for row in table.named_children("tr") {
        let mut cells = Vec::new();
        for cell in row.named_children("tc") {
            let text = cell
                .child("txBody")
                .map(|body| {
                    body.named_children("p")
                        .map(paragraph_text)
                        .collect::<Vec<_>>()
                        .join("\n")
                })
                .unwrap_or_default();
            let stripped = text.trim();
            if !stripped.is_empty() {
                cells.push(stripped.to_string());
            }
        }
        if !cells.is_empty() {
            rows.push(cells.join(" | "));
        }
    }
    rows
}

#[cfg(test)]
mod tests {
    use super::super::zip::stored_archive;
    use super::*;

    #[test]
    fn the_sld_id_list_yields_relationship_ids_in_order() {
        let presentation = concat!(
            "<p:presentation>",
            "<p:sldIdLst><p:sldId id=\"257\" r:id=\"rId2\"/><p:sldId id=\"258\" r:id=\"rId9\"/></p:sldIdLst>",
            "</p:presentation>"
        );
        assert_eq!(
            presentation_slide_ids(presentation).unwrap(),
            vec!["rId2".to_string(), "rId9".to_string()]
        );
    }

    #[test]
    fn slide_relationships_keep_only_package_slides() {
        let rels = concat!(
            "<Relationships>",
            "<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster\" Target=\"slideMasters/slideMaster1.xml\"/>",
            "<Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide\" Target=\"slides/slide1.xml\"/>",
            "<Relationship Id=\"rId3\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide\" Target=\"https://example.test/slide\" TargetMode=\"External\"/>",
            "</Relationships>"
        );
        assert_eq!(
            slide_relationship_targets(rels).unwrap(),
            vec![("rId2".to_string(), "slides/slide1.xml".to_string())]
        );
    }

    #[test]
    fn a_slide_renders_its_content_lines_under_the_header() {
        let slide = concat!(
            "<p:sld><p:cSld><p:spTree>",
            "<p:sp><p:txBody><a:p><a:r><a:t>标题</a:t></a:r></a:p></p:txBody></p:sp>",
            "<p:pic/>",
            "<p:sp><p:txBody><a:p><a:r><a:t>第一段</a:t></a:r></a:p><a:p><a:r><a:t>第二段</a:t></a:r></a:p></p:txBody></p:sp>",
            "</p:spTree></p:cSld></p:sld>"
        );
        assert_eq!(
            slide_text(slide, 7).unwrap().as_deref(),
            Some("--- Slide 7 ---\n标题\n第一段\n第二段")
        );
    }

    #[test]
    fn a_blank_slide_drops_out() {
        let slide = "<p:sld><p:cSld><p:spTree><p:sp><p:txBody><a:p/></p:txBody></p:sp></p:spTree></p:cSld></p:sld>";
        assert!(slide_text(slide, 1).unwrap().is_none());
    }

    /// A paragraph joins runs, fields, and vertical-tab line breaks.
    #[test]
    fn paragraph_text_mirrors_python_pptx() {
        let paragraph = Tree::new(
            "<a:p><a:r><a:t>AB</a:t></a:r><a:br/><a:fld><a:t>42</a:t></a:fld><a:r><a:t/></a:r></a:p>",
        )
        .find_element("p")
        .unwrap()
        .unwrap();
        assert_eq!(paragraph_text(&paragraph), "AB\u{0b}42");
    }

    /// A graphic frame is a table only for the DrawingML table URI.
    #[test]
    fn graphic_frame_table_detection_and_rows() {
        let table_frame = Tree::new(concat!(
            "<p:graphicFrame><p:graphic><a:graphicData uri=\"http://schemas.openxmlformats.org/drawingml/2006/table\">",
            "<a:tbl><a:tr><a:tc><a:txBody><a:p><a:r><a:t>A</a:t></a:r></a:p></a:txBody></a:tc>",
            "<a:tc><a:txBody><a:p><a:r><a:t>B</a:t></a:r></a:p></a:txBody></a:tc></a:tr>",
            "<a:tr><a:tc><a:txBody><a:p/></a:txBody></a:tc></a:tr></a:tbl>",
            "</a:graphicData></p:graphic></p:graphicFrame>"
        ))
        .find_element("graphicFrame")
        .unwrap()
        .unwrap();
        assert!(is_table_graphic_frame(&table_frame));
        assert_eq!(table_rows(&table_frame), vec!["A | B".to_string()]);

        let chart_frame = Tree::new(
            "<p:graphicFrame><p:graphic><a:graphicData uri=\"http://schemas.openxmlformats.org/drawingml/2006/chart\"/></p:graphic></p:graphicFrame>",
        )
        .find_element("graphicFrame")
        .unwrap()
        .unwrap();
        assert!(!is_table_graphic_frame(&chart_frame));
    }

    /// A whole package renders `prs.slides` order, skipping a blank slide.
    #[test]
    fn a_package_renders_its_slides_in_presentation_order() {
        let presentation = concat!(
            "<p:presentation><p:sldIdLst>",
            "<p:sldId id=\"257\" r:id=\"rId2\"/><p:sldId id=\"258\" r:id=\"rId3\"/>",
            "</p:sldIdLst></p:presentation>"
        );
        let rels = concat!(
            "<Relationships>",
            "<Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide\" Target=\"slides/slide1.xml\"/>",
            "<Relationship Id=\"rId3\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide\" Target=\"slides/slide2.xml\"/>",
            "</Relationships>"
        );
        let first = "<p:sld><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>one</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>";
        let second = "<p:sld><p:cSld><p:spTree></p:spTree></p:cSld></p:sld>";
        let archive = stored_archive(&[
            ("ppt/presentation.xml", presentation.as_bytes()),
            ("ppt/_rels/presentation.xml.rels", rels.as_bytes()),
            ("ppt/slides/slide1.xml", first.as_bytes()),
            ("ppt/slides/slide2.xml", second.as_bytes()),
        ]);
        let extracted = extract(&archive).expect("package parses");
        assert_eq!(extracted.slides, vec!["--- Slide 1 ---\none".to_string()]);
    }
}
