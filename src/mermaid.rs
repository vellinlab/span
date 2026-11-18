use gtk::cairo::{self, Context};
use gtk::{gdk, gdk_pixbuf};
use std::collections::HashMap;

const MAX_NODES: usize = 30;

pub enum Diagram {
    Flow {
        nodes: Vec<String>,
        edges: Vec<(usize, usize, String)>,
        vertical: bool,
    },
    Sequence {
        nodes: Vec<String>,
        messages: Vec<(usize, usize, String)>,
    },
}

impl Diagram {
    pub fn parse(source: &str) -> Option<Self> {
        let mut lines = source
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty() && !line.starts_with("%%"));
        let header = lines.next()?.trim_end_matches(';');
        let vertical = matches!(
            header,
            "flowchart TD" | "flowchart TB" | "graph TD" | "graph TB"
        );
        let flow = vertical || matches!(header, "flowchart LR" | "graph LR");
        let sequence = header == "sequenceDiagram";
        if !flow && !sequence {
            return None;
        }

        let mut nodes = Vec::new();
        let mut ids = HashMap::new();
        let mut edges = Vec::new();
        for line in lines {
            if edges.len() > 70 {
                return None;
            }
            for line in line
                .split(';')
                .map(str::trim)
                .filter(|line| !line.is_empty())
            {
                if flow {
                    let mut parts = line.split("-->");
                    let mut from = register(parts.next()?, &mut nodes, &mut ids)?;
                    for part in parts {
                        let (label, node) = if let Some(label) = part.trim().strip_prefix('|') {
                            label.split_once('|')?
                        } else {
                            ("", part)
                        };
                        let to = register(node, &mut nodes, &mut ids)?;
                        edges.push((from, to, label.trim().to_owned()));
                        from = to;
                    }
                } else if let Some(name) = line
                    .strip_prefix("participant ")
                    .or_else(|| line.strip_prefix("actor "))
                {
                    let (id, label) = name.split_once(" as ").unwrap_or((name, name));
                    let index = register(id, &mut nodes, &mut ids)?;
                    nodes[index] = label.trim().to_owned();
                } else {
                    let (link, label) = line.split_once(':')?;
                    let (from, to) = ["-->>", "->>", "-->", "->"]
                        .into_iter()
                        .find_map(|arrow| link.split_once(arrow))?;
                    let from = register(from, &mut nodes, &mut ids)?;
                    let to = register(to, &mut nodes, &mut ids)?;
                    edges.push((from, to, label.trim().to_owned()));
                }
            }
        }
        if nodes.is_empty() {
            return None;
        }
        if sequence {
            Some(Self::Sequence {
                nodes,
                messages: edges,
            })
        } else {
            Some(Self::Flow {
                nodes,
                edges,
                vertical,
            })
        }
    }

    pub fn dimensions(&self) -> (i32, i32) {
        match self {
            Self::Flow {
                nodes,
                edges,
                vertical,
            } => {
                let positions = positions(nodes.len(), edges);
                let ranks = positions.iter().map(|p| p.0).max().unwrap_or_default() + 1;
                let lanes = positions.iter().map(|p| p.1).max().unwrap_or_default() + 1;
                if *vertical {
                    (30 + 152 * lanes as i32, 30 + 86 * ranks as i32)
                } else {
                    (30 + 186 * ranks as i32, 30 + 68 * lanes as i32)
                }
            }
            Self::Sequence { nodes, messages } => (
                24 + 142 * nodes.len() as i32,
                85 + 38 * messages.len() as i32,
            ),
        }
    }

    pub fn draw(&self, cr: &Context, width: i32, height: i32) {
        cr.set_source_rgb(0.09, 0.10, 0.12);
        let _ = cr.paint();
        let (base_width, base_height) = self.dimensions();
        let scale = (f64::from(width) / f64::from(base_width))
            .min(f64::from(height) / f64::from(base_height));
        cr.translate(
            (f64::from(width) - scale * f64::from(base_width)) / 2.0,
            0.0,
        );
        cr.scale(scale, scale);
        cr.set_line_width(1.5);
        cr.select_font_face("Sans", cairo::FontSlant::Normal, cairo::FontWeight::Normal);
        cr.set_font_size(13.0);

        match self {
            Self::Flow {
                nodes,
                edges,
                vertical,
            } => {
                let points: Vec<_> = positions(nodes.len(), edges)
                    .into_iter()
                    .map(|(rank, lane)| {
                        if *vertical {
                            (80.0 + 152.0 * lane as f64, 40.0 + 86.0 * rank as f64)
                        } else {
                            (80.0 + 186.0 * rank as f64, 40.0 + 68.0 * lane as f64)
                        }
                    })
                    .collect();
                for (from, to, label) in edges {
                    let (a, b) = (points[*from], points[*to]);
                    if a == b {
                        continue;
                    }
                    let (a, b) = if *vertical && a.1 != b.1 {
                        let sign = (b.1 - a.1).signum();
                        ((a.0, a.1 + 19.0 * sign), (b.0, b.1 - 19.0 * sign))
                    } else {
                        let sign = (b.0 - a.0).signum();
                        ((a.0 + 63.0 * sign, a.1), (b.0 - 63.0 * sign, b.1))
                    };
                    arrow(cr, a, b);
                    if !label.is_empty() {
                        text(cr, (a.0 + b.0) / 2.0, (a.1 + b.1) / 2.0 - 6.0, label, 18);
                    }
                }
                for ((x, y), node) in points.into_iter().zip(nodes) {
                    node_box(cr, x, y, node);
                }
            }
            Self::Sequence { nodes, messages } => {
                let x = |i| 79.0 + 142.0 * i as f64;
                for (i, name) in nodes.iter().enumerate() {
                    let x = x(i);
                    cr.set_source_rgb(0.32, 0.37, 0.44);
                    cr.move_to(x, 57.0);
                    cr.line_to(x, f64::from(base_height) - 15.0);
                    let _ = cr.stroke();
                    node_box(cr, x, 33.0, name);
                }
                for (i, (from, to, label)) in messages.iter().enumerate() {
                    let y = 86.0 + 38.0 * i as f64;
                    let (a, b) = (x(*from), x(*to));
                    if a == b {
                        arrow(cr, (a + 34.0, y), (a, y));
                        text(cr, a + 50.0, y - 8.0, label, 24);
                    } else {
                        arrow(cr, (a, y), (b, y));
                        text(cr, (a + b) / 2.0, y - 8.0, label, 42);
                    }
                }
            }
        }
    }

    pub fn image(&self) -> Option<gdk_pixbuf::Pixbuf> {
        let (width, height) = self.dimensions();
        let surface = cairo::ImageSurface::create(cairo::Format::ARgb32, width, height).ok()?;
        let cr = Context::new(&surface).ok()?;
        self.draw(&cr, width, height);
        gdk::pixbuf_get_from_surface(&surface, 0, 0, width, height)
    }
}

fn register(
    input: &str,
    nodes: &mut Vec<String>,
    ids: &mut HashMap<String, usize>,
) -> Option<usize> {
    let input = input.trim();
    let boundary = input
        .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .unwrap_or(input.len());
    let id = &input[..boundary];
    if id.is_empty() {
        return None;
    }
    let label = input[boundary..].trim();
    let label = if label.is_empty() {
        None
    } else {
        let label = [('[', ']'), ('(', ')'), ('{', '}')]
            .into_iter()
            .find_map(|(a, b)| label.strip_prefix(a)?.strip_suffix(b))?;
        Some(
            label
                .trim_matches(['[', ']', '(', ')', '{', '}', '"'])
                .to_owned(),
        )
    };
    if let Some(&index) = ids.get(id) {
        if let Some(label) = label {
            nodes[index] = label;
        }
        return Some(index);
    }
    if nodes.len() == MAX_NODES {
        return None;
    }
    let index = nodes.len();
    nodes.push(label.unwrap_or_else(|| id.to_owned()));
    ids.insert(id.to_owned(), index);
    Some(index)
}

fn positions(count: usize, edges: &[(usize, usize, String)]) -> Vec<(usize, usize)> {
    let mut rank = vec![0; count];
    // Assign ranks in source order and place backward edges without expanding cycles.
    for (from, to, _) in edges {
        if from < to {
            rank[*to] = rank[*to].max(rank[*from] + 1);
        }
    }
    let mut lanes = vec![0; count];
    rank.into_iter()
        .map(|rank| {
            let lane = lanes[rank];
            lanes[rank] += 1;
            (rank, lane)
        })
        .collect()
}

fn node_box(cr: &Context, x: f64, y: f64, label: &str) {
    cr.set_source_rgb(0.14, 0.20, 0.31);
    cr.rectangle(x - 63.0, y - 19.0, 126.0, 38.0);
    let _ = cr.fill_preserve();
    cr.set_source_rgb(0.34, 0.51, 0.76);
    let _ = cr.stroke();
    text(cr, x, y + 4.0, label, 17);
}

fn text(cr: &Context, x: f64, y: f64, text: &str, limit: usize) {
    let text = text.replace(['\0', '\r', '\n'], " ");
    let mut rendered: String = text.chars().take(limit).collect();
    if text.chars().nth(limit).is_some() {
        rendered.push('…');
    }
    cr.set_source_rgb(0.84, 0.88, 0.94);
    if let Ok(size) = cr.text_extents(&rendered) {
        cr.move_to(x - size.width() / 2.0 - size.x_bearing(), y);
    }
    let _ = cr.show_text(&rendered);
}

fn arrow(cr: &Context, (ax, ay): (f64, f64), (bx, by): (f64, f64)) {
    let angle = (by - ay).atan2(bx - ax);
    cr.set_source_rgb(0.43, 0.64, 0.91);
    cr.move_to(ax, ay);
    cr.line_to(bx, by);
    for offset in [-0.55f64, 0.55] {
        cr.move_to(
            bx - 8.0 * (angle + offset).cos(),
            by - 8.0 * (angle + offset).sin(),
        );
        cr.line_to(bx, by);
    }
    let _ = cr.stroke();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_common_flowcharts_and_sequences() {
        assert!(
            Diagram::parse("flowchart TD\nA[Start] -->|ok| B[End]")
                .unwrap()
                .image()
                .is_some()
        );
        assert!(
            Diagram::parse("sequenceDiagram\nparticipant C as Client\nC->>S: Ping")
                .unwrap()
                .image()
                .is_some()
        );
        assert!(Diagram::parse("pie\n\"A\": 12").is_none());
    }
}
