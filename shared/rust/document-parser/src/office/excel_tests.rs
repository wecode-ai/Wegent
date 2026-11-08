use super::*;

#[test]
fn complete_text_preserves_formula_coordinates_and_checks_encoded_bytes() {
    let bytes = package(
        "<worksheet><sheetData><row r=\"7\"><c r=\"C7\"><f>1+1</f><v>2</v></c></row></sheetData></worksheet>",
        None,
        None,
    );
    let archive = ZipArchive::new(&bytes).unwrap();
    let expected = "--- Sheet: Sheet1 ---\nR7: [3]={\"formula\":\"=1+1\",\"value\":2}";
    assert_eq!(
        read_text_with_limits(&archive, 8192, expected.len()).unwrap(),
        expected
    );
    assert!(read_text_with_limits(&archive, 8192, expected.len() - 1).is_err());
}

#[test]
fn overflowing_coordinates_fail_without_wrapping_or_panicking() {
    assert!(coordinate_to_tuple("ZZZZZZZZZZZZZZZZZZZZ1").is_err());
    let bytes = package(
        &format!(
            "<worksheet><sheetData><row r=\"{}\"><c><v>1</v></c></row><row><c><v>2</v></c></row></sheetData></worksheet>",
            u64::MAX
        ),
        None,
        None,
    );
    assert!(read_sheets(&bytes).is_err());
    let bytes = package(
        &format!(
            "<worksheet><sheetData><row r=\"{}\"><c><v>1</v></c></row><row r=\"2\"><c><v>2</v></c></row></sheetData></worksheet>",
            u64::MAX
        ),
        None,
        None,
    );
    assert_eq!(read_sheets(&bytes).unwrap()[0].rows[1].source_row, 2);
    let row = ExcelRow {
        source_row: 1,
        cells: vec![ExcelCell {
            source_column: u64::MAX,
            value: ExcelValue::Integer("1".into()),
        }],
    };
    assert_eq!(compact_row_line(&row), format!("R1: [{}]=1", u64::MAX));
}

#[test]
fn shared_string_expansion_and_formula_cache_share_the_value_budget() {
    let sheet = "<worksheet><sheetData><row r=\"1\"><c r=\"A1\" t=\"s\"><v>0</v></c><c r=\"B1\" t=\"s\"><v>0</v></c></row></sheetData></worksheet>";
    let value = "授权资料".repeat(1000);
    let strings = format!("<sst><si><t>{value}</t></si></sst>");
    let bytes = package(sheet, Some(&strings), None);
    let archive = ZipArchive::new(&bytes).unwrap();
    let limit = 2 * (std::mem::size_of::<ExcelValue>() + value.len());
    assert_eq!(
        read_sheets_with_value_limit(&archive, limit).unwrap(),
        read_sheets(&bytes).unwrap()
    );
    assert!(read_sheets_with_value_limit(&archive, limit - 1).is_err());
    let bytes = package(
        "<worksheet><sheetData><row r=\"1\"><c r=\"A1\"><f>1+1</f><v>2</v></c></row></sheetData></worksheet>",
        None,
        None,
    );
    let archive = ZipArchive::new(&bytes).unwrap();
    let limit = 2 * std::mem::size_of::<ExcelValue>() + "=1+1".len() + "2".len();
    assert_eq!(
        read_sheets_with_value_limit(&archive, limit).unwrap(),
        read_sheets(&bytes).unwrap()
    );
    assert!(read_sheets_with_value_limit(&archive, limit - 1).is_err());
}

#[test]
fn optional_parts_do_not_hide_decoded_budget_failures() {
    let bytes = super::super::zip::stored_archive(&[
        ("xl/sharedStrings.xml", b"<sst/>"),
        ("xl/styles.xml", b"<styleSheet/>"),
    ]);
    let archive = ZipArchive::with_decoded_byte_limit(&bytes, 1).unwrap();
    assert!(read_shared_strings(&archive).is_err());
    let archive = ZipArchive::with_decoded_byte_limit(&bytes, 1).unwrap();
    assert!(read_styles(&archive).is_err());
    let bytes = super::super::zip::stored_archive(&[]);
    let archive = ZipArchive::with_decoded_byte_limit(&bytes, 0).unwrap();
    assert!(read_shared_strings(&archive).unwrap().is_empty());
    assert!(read_styles(&archive).is_ok());
}

#[test]
fn shared_formula_cells_expand_before_merging_cached_values() {
    let xml = "<worksheet><sheetData>\
        <row r=\"1\"><c r=\"A1\"><v>1</v></c><c r=\"B1\">\
        <f t=\"shared\" si=\"0\" ref=\"B1:B2\">A1*2</f><v>2</v></c></row>\
        <row r=\"2\"><c r=\"A2\"><v>2</v></c><c r=\"B2\">\
        <f t=\"shared\" si=\"0\"/><v>4</v></c></row>\
        </sheetData></worksheet>";
    let sheets = read_sheets(&package(xml, None, None)).unwrap();
    assert_eq!(
        sheets[0].rows[1].cells[1].value.to_json(),
        r#"{"formula":"=A2*2","value":4}"#
    );
}

/// A minimal workbook package: the workbook, its relationships and one
/// worksheet, with optional shared strings and styles.
fn package(sheet_xml: &str, shared_strings: Option<&str>, styles: Option<&str>) -> Vec<u8> {
    let mut entries: Vec<(String, Vec<u8>)> = Vec::new();
    entries.push((
        "xl/workbook.xml".to_string(),
        concat!(
            "<?xml version=\"1.0\"?><workbook><sheets>",
            "<sheet name=\"Sheet1\" sheetId=\"1\" r:id=\"rId1\"/></sheets></workbook>"
        )
        .as_bytes()
        .to_vec(),
    ));
    let mut relationships = String::from(
        "<?xml version=\"1.0\"?><Relationships>\
         <Relationship Id=\"rId1\" Target=\"worksheets/sheet1.xml\"/>",
    );
    if shared_strings.is_some() {
        relationships.push_str("<Relationship Id=\"rId2\" Target=\"sharedStrings.xml\"/>");
    }
    if styles.is_some() {
        relationships.push_str("<Relationship Id=\"rId3\" Target=\"styles.xml\"/>");
    }
    relationships.push_str("</Relationships>");
    entries.push((
        "xl/_rels/workbook.xml.rels".to_string(),
        relationships.into_bytes(),
    ));
    if let Some(shared) = shared_strings {
        entries.push((
            "xl/sharedStrings.xml".to_string(),
            shared.as_bytes().to_vec(),
        ));
    }
    if let Some(styles) = styles {
        entries.push(("xl/styles.xml".to_string(), styles.as_bytes().to_vec()));
    }
    entries.push((
        "xl/worksheets/sheet1.xml".to_string(),
        sheet_xml.as_bytes().to_vec(),
    ));
    let borrowed: Vec<(&str, &[u8])> = entries
        .iter()
        .map(|(name, payload)| (name.as_str(), payload.as_slice()))
        .collect();
    super::super::zip::stored_archive(&borrowed)
}

fn sheet_data(rows: &str) -> String {
    format!(
        "<?xml version=\"1.0\"?><worksheet><sheetPr/><dimension/>\
         <sheetData>{rows}</sheetData></worksheet>"
    )
}

#[test]
fn cells_normalize_with_their_physical_coordinates() {
    let shared = "<?xml version=\"1.0\"?><sst><si><t>uid</t></si>\
                  <si><r><t>rich</t></r><r><t> text</t></r></si></sst>";
    let data = package(
        &sheet_data(
            "<row r=\"1\"><c r=\"A1\" t=\"s\"><v>0</v></c>\
             <c r=\"B1\" t=\"s\"><v>1</v></c><c r=\"C1\" t=\"b\"><v>1</v></c>\
             <c r=\"D1\" t=\"e\"><v>#DIV/0!</v></c></row>\
             <row r=\"2\"><c r=\"A2\"><v>42</v></c><c r=\"B2\"><v>2.5</v></c>\
             <c r=\"C2\"><v>3.0</v></c><c r=\"D2\" t=\"inlineStr\"><is><t>inline</t></is></c>\
             <c r=\"E2\"></c></row>\
             <row r=\"4\"><c r=\"C4\"><v>7</v></c></row>",
        ),
        Some(shared),
        None,
    );
    let sheets = read_sheets(&data).expect("package reads");
    assert_eq!(sheets[0].name, "Sheet1");
    assert_eq!(
        serialize_sheet_compact(&sheets[0]),
        "--- Sheet: Sheet1 ---\n\
         R1: \"uid\" | \"rich text\" | true | \"#DIV/0!\"\n\
         R2: 42 | 2.5 | 3 | \"inline\"\n\
         R4: [3]=7"
    );
}

#[test]
fn number_formats_turn_serials_into_dates() {
    let styles = "<?xml version=\"1.0\"?><styleSheet>\
                  <numFmts count=\"1\"><numFmt numFmtId=\"164\" formatCode=\"yyyy\\-mm\\-dd\"/>\
                  </numFmts><cellXfs count=\"3\"><xf numFmtId=\"0\"/><xf numFmtId=\"14\"/>\
                  <xf numFmtId=\"164\"/></cellXfs></styleSheet>";
    let data = package(
        &sheet_data(
            "<row r=\"1\"><c r=\"A1\" s=\"1\"><v>45000.5</v></c>\
             <c r=\"B1\" s=\"2\"><v>45000.5</v></c><c r=\"C1\" s=\"2\"><v>0.25</v></c>\
             <c r=\"D1\" s=\"2\"><v>58.999</v></c><c r=\"E1\" s=\"1\"><v>45000</v></c></row>",
        ),
        None,
        Some(styles),
    );
    let sheets = read_sheets(&data).expect("package reads");
    assert_eq!(
        sheets[0].rows[0]
            .cells
            .iter()
            .map(|cell| cell.value.to_json())
            .collect::<Vec<_>>(),
        vec![
            "\"2023-03-15T12:00:00\"",
            "\"2023-03-15T12:00:00\"",
            "\"06:00:00\"",
            "\"1900-02-27T23:58:33.600000\"",
            "\"2023-03-15T00:00:00\"",
        ]
    );
}

#[test]
fn formula_cells_merge_their_cached_result() {
    let data = package(
        &sheet_data(
            "<row r=\"1\"><c r=\"A1\"><v>1</v></c><c r=\"B1\"><v>2</v></c></row>\
             <row r=\"2\"><c r=\"A2\"><f>SUM(A1:B1)</f><v>3</v></c>\
             <c r=\"B2\" t=\"str\"><f>CONCATENATE(\"a\",\"b\")</f><v>ab</v></c>\
             <c r=\"C2\"><f>1+2</f></c></row>",
        ),
        None,
        None,
    );
    let sheets = read_sheets(&data).expect("package reads");
    assert_eq!(
        serialize_sheet_compact(&sheets[0]),
        "--- Sheet: Sheet1 ---\n\
         R1: 1 | 2\n\
         R2: {\"formula\":\"=SUM(A1:B1)\",\"value\":3} | \
         {\"formula\":\"=CONCATENATE(\\\"a\\\",\\\"b\\\")\",\"value\":\"ab\"} | \"=1+2\""
    );
}

#[test]
fn a_package_without_a_worksheet_is_a_parse_failure() {
    let missing = super::super::zip::stored_archive(&[("xl/workbook.xml", b"<workbook/>")]);
    assert!(read_sheets(&missing).is_err());
}
