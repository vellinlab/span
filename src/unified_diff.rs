#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Kind {
    Added,
    Removed,
    Context,
    Header,
}

pub(crate) struct Line<'a> {
    pub(crate) text: &'a str,
    pub(crate) kind: Kind,
    pub(crate) old: Option<u32>,
    pub(crate) new: Option<u32>,
}

pub(crate) fn lines(source: &str) -> impl Iterator<Item = Line<'_>> {
    let mut hunk = None;
    source.split_inclusive('\n').map(move |text| {
        let (kind, old, new) = if let Some(range) = Hunk::parse(text) {
            hunk = Some(range);
            (Kind::Header, None, None)
        } else if let Some(range) = hunk
            .as_mut()
            .filter(|range| range.old.1 > 0 || range.new.1 > 0)
        {
            match text.as_bytes().first() {
                Some(b'+') => (Kind::Added, None, next_line(&mut range.new)),
                Some(b'-') => (Kind::Removed, next_line(&mut range.old), None),
                Some(b' ') => (
                    Kind::Context,
                    next_line(&mut range.old),
                    next_line(&mut range.new),
                ),
                _ => (Kind::Header, None, None),
            }
        } else {
            (Kind::Header, None, None)
        };
        Line {
            text,
            kind,
            old,
            new,
        }
    })
}

struct Hunk {
    old: (u32, u32),
    new: (u32, u32),
}

impl Hunk {
    fn parse(line: &str) -> Option<Self> {
        let mut parts = line.strip_prefix("@@ ")?.split_whitespace();
        let old = parse_range(parts.next()?.strip_prefix('-')?)?;
        let new = parse_range(parts.next()?.strip_prefix('+')?)?;
        (parts.next()? == "@@").then_some(Self { old, new })
    }
}

fn parse_range(range: &str) -> Option<(u32, u32)> {
    let (line, count) = range.split_once(',').unwrap_or((range, "1"));
    Some((line.parse().ok()?, count.parse().ok()?))
}

fn next_line(range: &mut (u32, u32)) -> Option<u32> {
    if range.1 == 0 {
        return None;
    }
    let line = range.0;
    range.0 = range.0.saturating_add(1);
    range.1 -= 1;
    Some(line)
}
