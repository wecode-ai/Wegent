//! Alembic revision graph, including branch and merge version-table semantics.

use std::collections::{BTreeMap, BTreeSet};

use anyhow::{Result, bail, ensure};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub struct Revision {
    pub revision: String,
    pub parents: Vec<String>,
    pub source: String,
    pub upgrade: Option<Vec<Step>>,
    pub downgrade: Option<Vec<Step>>,
}

#[derive(Debug, Deserialize)]
pub struct Step {
    pub sql: Vec<String>,
    pub when: Option<Condition>,
    #[serde(default)]
    pub warning: bool,
}

#[derive(Debug, Deserialize)]
pub struct Condition {
    pub query: String,
    pub nonzero: bool,
}

pub struct Graph {
    pub revisions: Vec<Revision>,
    index: BTreeMap<String, usize>,
    pub head: String,
}

impl Graph {
    pub fn load() -> Result<Self> {
        Self::parse(&format!("[{}]", super::assets::REVISIONS.join(",")))
    }

    pub fn parse(json: &str) -> Result<Self> {
        let revisions: Vec<Revision> = serde_json::from_str(json)?;
        let index: BTreeMap<_, _> = revisions
            .iter()
            .enumerate()
            .map(|(i, r)| (r.revision.clone(), i))
            .collect();
        ensure!(
            index.len() == revisions.len(),
            "duplicate migration revision"
        );
        let mut heads: BTreeSet<_> = index.keys().cloned().collect();
        for revision in &revisions {
            for parent in &revision.parents {
                ensure!(
                    index.contains_key(parent),
                    "missing parent revision {parent}"
                );
                heads.remove(parent);
            }
        }
        ensure!(
            heads.len() == 1,
            "expected one migration head, found {heads:?}"
        );
        let graph = Self {
            revisions,
            index,
            head: heads.pop_first().unwrap(),
        };
        let mut done = BTreeSet::new();
        graph.visit(&graph.head, &mut BTreeSet::new(), &mut done)?;
        ensure!(
            done.len() == graph.revisions.len(),
            "disconnected migration graph"
        );
        Ok(graph)
    }

    pub fn get(&self, id: &str) -> Result<&Revision> {
        self.index
            .get(id)
            .map(|i| &self.revisions[*i])
            .ok_or_else(|| anyhow::anyhow!("unknown Alembic revision {id}"))
    }

    fn visit(
        &self,
        id: &str,
        visiting: &mut BTreeSet<String>,
        done: &mut BTreeSet<String>,
    ) -> Result<()> {
        if done.contains(id) {
            return Ok(());
        }
        ensure!(
            visiting.insert(id.into()),
            "migration dependency cycle at {id}"
        );
        for parent in &self.get(id)?.parents {
            self.visit(parent, visiting, done)?;
        }
        visiting.remove(id);
        done.insert(id.into());
        Ok(())
    }

    pub fn ancestors(&self, heads: &BTreeSet<String>) -> Result<BTreeSet<String>> {
        let mut done = BTreeSet::new();
        for head in heads {
            self.visit(head, &mut BTreeSet::new(), &mut done)?;
        }
        Ok(done)
    }

    pub fn upgrade<'a>(
        &'a self,
        heads: &BTreeSet<String>,
        target: &str,
    ) -> Result<Vec<&'a Revision>> {
        let mut applied = self.ancestors(heads)?;
        let wanted = self.ancestors(&BTreeSet::from([target.into()]))?;
        ensure!(
            applied.is_subset(&wanted),
            "target {target} is not an upgrade of {heads:?}"
        );
        let mut plan = Vec::new();
        while applied != wanted {
            let next = self.revisions.iter().find(|r| {
                wanted.contains(&r.revision)
                    && !applied.contains(&r.revision)
                    && r.parents.iter().all(|p| applied.contains(p))
            });
            let Some(next) = next else {
                bail!("cannot resolve migration upgrade path");
            };
            applied.insert(next.revision.clone());
            plan.push(next);
        }
        Ok(plan)
    }

    pub fn downgrade<'a>(
        &'a self,
        heads: &BTreeSet<String>,
        target: &str,
    ) -> Result<Vec<&'a Revision>> {
        let applied = self.ancestors(heads)?;
        let wanted = if target == "base" {
            BTreeSet::new()
        } else {
            self.ancestors(&BTreeSet::from([target.into()]))?
        };
        ensure!(
            wanted.is_subset(&applied),
            "target {target} is not a downgrade of {heads:?}"
        );
        let mut plan = self.upgrade(&BTreeSet::new(), &self.head)?;
        plan.retain(|r| applied.contains(&r.revision) && !wanted.contains(&r.revision));
        plan.reverse();
        Ok(plan)
    }

    pub fn frontier(&self, applied: &BTreeSet<String>) -> Result<BTreeSet<String>> {
        let mut heads = applied.clone();
        for id in applied {
            for parent in &self.get(id)?.parents {
                heads.remove(parent);
            }
        }
        Ok(heads)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checked_in_graph_preserves_all_legacy_revisions() {
        let graph = Graph::load().unwrap();
        assert_eq!(graph.revisions.len(), 66);
        assert_eq!(graph.head, "b1c2d3e4f5a6");
        assert_eq!(
            graph
                .revisions
                .iter()
                .filter(|r| r.parents.len() > 1)
                .count(),
            6
        );
        let plan = graph.upgrade(&BTreeSet::new(), &graph.head).unwrap();
        assert_eq!(plan.len(), 66);
        let mut applied = BTreeSet::new();
        for revision in plan {
            assert!(revision.parents.iter().all(|p| applied.contains(p)));
            applied.insert(revision.revision.clone());
        }
        assert_eq!(
            graph.frontier(&applied).unwrap(),
            BTreeSet::from([graph.head.clone()])
        );
        for revision in &graph.revisions {
            super::super::legacy::validate(revision, false).unwrap();
            super::super::legacy::validate(revision, true).unwrap();
        }
    }

    #[test]
    fn merge_consumes_both_heads_without_replaying_their_ancestors() {
        let graph = Graph::load().unwrap();
        let heads = BTreeSet::from(["b7d0e2f5a4c3".into(), "f7b8c9d0e1a2".into()]);
        let plan = graph.upgrade(&heads, "580031eb7ddc").unwrap();
        assert_eq!(
            plan.iter().map(|r| r.revision.as_str()).collect::<Vec<_>>(),
            ["580031eb7ddc"]
        );
        let mut applied = graph.ancestors(&heads).unwrap();
        applied.insert("580031eb7ddc".into());
        assert_eq!(
            graph.frontier(&applied).unwrap(),
            BTreeSet::from(["580031eb7ddc".into()])
        );
        applied.remove("580031eb7ddc");
        assert_eq!(graph.frontier(&applied).unwrap(), heads);
    }

    #[test]
    fn unknown_versions_and_wrong_direction_are_rejected() {
        let graph = Graph::load().unwrap();
        assert!(
            graph
                .upgrade(&BTreeSet::from(["unknown".into()]), &graph.head)
                .is_err()
        );
        assert!(
            graph
                .upgrade(&BTreeSet::from([graph.head.clone()]), "c9900f078622")
                .is_err()
        );
        assert!(Graph::parse(r#"[{"revision":"a","parents":["missing"],"source":"a"}]"#).is_err());
    }
}
