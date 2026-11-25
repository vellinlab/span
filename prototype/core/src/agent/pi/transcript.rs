use serde_json::Value;
use std::io;

const PAGE_TURNS: usize = 20;
const PAGE_BYTES: usize = 16 * 1024 * 1024;

#[derive(Clone)]
pub(super) struct Cursor {
    pub(super) end: u64,
    pub(super) parent: String,
}

pub(super) struct BranchPage {
    parent: Option<String>,
    found_leaf: bool,
    past_tail: bool,
    fragments: Vec<Vec<u8>>,
    fragment_bytes: usize,
    entries: Vec<Value>,
    entry_bytes: usize,
    turns: usize,
    done: bool,
    next: Option<Cursor>,
}

impl BranchPage {
    pub(super) fn new(parent: Option<String>) -> Self {
        Self {
            found_leaf: parent.is_some(),
            parent,
            past_tail: false,
            fragments: Vec::new(),
            fragment_bytes: 0,
            entries: Vec::new(),
            entry_bytes: 0,
            turns: 0,
            done: false,
            next: None,
        }
    }

    fn accept(&mut self, start: u64, line: &[u8]) -> io::Result<()> {
        let length = line.len() + self.fragment_bytes;
        if length > PAGE_BYTES {
            return Err(io::Error::other("Pi 子代理单条记录超过 16 MiB。"));
        }
        let mut joined = Vec::new();
        let line = if self.fragments.is_empty() {
            line
        } else {
            joined.reserve(length);
            joined.extend_from_slice(line);
            for fragment in self.fragments.drain(..).rev() {
                joined.extend_from_slice(&fragment);
            }
            self.fragment_bytes = 0;
            &joined
        };
        let Ok(entry) = serde_json::from_slice::<Value>(line) else {
            return Ok(());
        };
        let Some(id) = entry["id"].as_str().filter(|id| !id.is_empty()) else {
            return Ok(());
        };
        if entry["type"] == "session" || self.found_leaf && self.parent.as_deref() != Some(id) {
            return Ok(());
        }
        self.found_leaf = true;
        self.parent = entry["parentId"].as_str().map(str::to_owned);
        if entry["type"] == "message" && entry["message"]["role"].is_string() {
            self.turns += usize::from(entry["message"]["role"] == "user");
            self.entry_bytes += length;
            if self.entry_bytes > PAGE_BYTES {
                return Err(io::Error::other("Pi 子代理这一页的记录超过 16 MiB。"));
            }
            self.entries.push(entry);
        }
        if self.turns == PAGE_TURNS {
            self.next = self
                .parent
                .take()
                .map(|parent| Cursor { end: start, parent });
        }
        self.done = self.parent.is_none();
        Ok(())
    }

    // Chunks arrive newest first. A complete record starts just after the preceding newline.
    pub(super) fn read(&mut self, start: u64, bytes: &[u8]) -> io::Result<bool> {
        let mut end = bytes.len();
        for index in (0..end).rev().filter(|index| bytes[*index] == b'\n') {
            if self.past_tail {
                self.accept(start + index as u64 + 1, &bytes[index + 1..end])?;
                if self.done {
                    return Ok(true);
                }
            }
            self.past_tail = true;
            end = index;
        }
        if start == 0 {
            if self.past_tail {
                self.accept(0, &bytes[..end])?;
            }
            return Ok(true);
        }
        if self.past_tail && end > 0 {
            self.fragment_bytes += end;
            if self.fragment_bytes > PAGE_BYTES {
                return Err(io::Error::other("Pi 子代理单条记录超过 16 MiB。"));
            }
            self.fragments.push(bytes[..end].to_vec());
        }
        Ok(false)
    }

    pub(super) fn finish(mut self) -> (Vec<Value>, Option<Cursor>) {
        self.entries.reverse();
        (self.entries, self.next)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn scan(bytes: &[u8], cursor: Option<Cursor>) -> (Vec<Value>, Option<Cursor>) {
        let end = cursor
            .as_ref()
            .map_or(bytes.len(), |cursor| cursor.end as usize);
        let mut page = BranchPage::new(cursor.map(|cursor| cursor.parent));
        let mut remaining = end;
        while remaining > 0 {
            let start = remaining.saturating_sub(11);
            if page.read(start as u64, &bytes[start..remaining]).unwrap() {
                break;
            }
            remaining = start;
        }
        page.finish()
    }

    #[test]
    fn follows_the_saved_branch_across_blocks_and_pages() {
        let mut records = vec![json!({"type":"session","id":"header"})];
        for index in 0..24 {
            let parent = (index > 0).then(|| format!("reply-{}", index - 1));
            records.push(
                json!({"type":"message","id":format!("ask-{index}"),"parentId":parent,
                "message":{"role":"user","content":"请核对记录"}}),
            );
            if index == 7 {
                records.push(json!({"type":"message","id":"abandoned","parentId":"ask-7",
                    "message":{"role":"assistant","content":"Unselected branch"}}));
                records.push(json!({"type":"model_change","id":"model","parentId":"ask-7"}));
            }
            let parent = if index == 7 {
                "model".to_owned()
            } else {
                format!("ask-{index}")
            };
            records.push(
                json!({"type":"message","id":format!("reply-{index}"),"parentId":parent,
                "message":{"role":"assistant","content":"已完成"}}),
            );
        }
        let mut contents = records
            .into_iter()
            .map(|entry| entry.to_string() + "\r\n")
            .collect::<String>();
        contents.push_str("{ malformed }\n{\"id\":\"unfinished\"");
        let (latest, cursor) = scan(contents.as_bytes(), None);
        assert_eq!(latest.len(), 40);
        assert_eq!(latest.first().unwrap()["id"], "ask-4");
        assert_eq!(latest.last().unwrap()["id"], "reply-23");
        assert_eq!(latest[7]["id"], "reply-7");
        let cursor = cursor.unwrap();
        assert_eq!(cursor.parent, "reply-3");
        let (older, cursor) = scan(contents.as_bytes(), Some(cursor));
        assert_eq!(older.len(), 8);
        assert_eq!(older.first().unwrap()["message"]["content"], "请核对记录");
        assert_eq!(older.last().unwrap()["id"], "reply-3");
        assert!(cursor.is_none());
    }
}
