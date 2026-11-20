use gtk::prelude::*;
use gtk::{cairo, gdk, gdk_pixbuf, glib};

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Icon {
    Terminal,
    Conversation,
    TerminalDrawer,
    RemoteHost,
    Connect,
    Plus,
    Close,
    More,
    Folder,
    File,
    Link,
    ExternalLink,
    Attachment,
    Shield,
    ChevronDown,
    ChevronRight,
    Bolt,
    Up,
    Stop,
    Pause,
    Refresh,
    Upload,
    Download,
    Copy,
    CopyRich,
    Search,
    Activity,
    Book,
    Edit,
    Globe,
    Tool,
}

pub fn widget(icon: Icon, size: i32) -> gtk::DrawingArea {
    changing_widget(size, move || icon)
}

pub fn changing_widget(size: i32, symbol: impl Fn() -> Icon + 'static) -> gtk::DrawingArea {
    drawing_widget(size, None, symbol)
}

pub fn aligned_widget(
    size: i32,
    label: &gtk::Label,
    symbol: impl Fn() -> Icon + 'static,
) -> gtk::DrawingArea {
    drawing_widget(size, Some(label), symbol)
}

fn drawing_widget(
    size: i32,
    label: Option<&gtk::Label>,
    symbol: impl Fn() -> Icon + 'static,
) -> gtk::DrawingArea {
    let area = gtk::DrawingArea::new();
    area.set_size_request(size, if label.is_some() { size + 4 } else { size });
    area.set_halign(gtk::Align::Center);
    area.set_valign(gtk::Align::Center);
    if let Some(label) = label {
        let weak = area.downgrade();
        label.connect_label_notify(move |_| {
            if let Some(area) = weak.upgrade() {
                area.queue_draw();
            }
        });
    }
    let label = label.map(|label| label.downgrade());
    area.connect_draw(move |area, cr| {
        let style = area.style_context();
        let color = style.color(area.state_flags());
        let available = f64::from((area.allocated_height() - size).max(0));
        let y = label
            .as_ref()
            .and_then(|label| label.upgrade())
            .and_then(|label| {
                let (ink, _) = label.layout()?.pixel_extents();
                let (_, top) = label.layout_offsets();
                // Both title widgets are siblings in the same GDK window.
                let center = f64::from(top + ink.y() - area.allocation().y())
                    + f64::from(ink.height()) / 2.0;
                (ink.height() > 0).then_some(center - f64::from(size) / 2.0)
            })
            .unwrap_or(available / 2.0)
            .clamp(0.0, available);
        draw(cr, symbol(), size, y, &color);
        glib::Propagation::Proceed
    });
    area
}

pub fn pixbuf(icon: Icon, size: i32, color: &gdk::RGBA) -> Option<gdk_pixbuf::Pixbuf> {
    let surface = cairo::ImageSurface::create(cairo::Format::ARgb32, size, size).ok()?;
    {
        let cr = cairo::Context::new(&surface).ok()?;
        draw(&cr, icon, size, 0.0, color);
    }
    gdk::pixbuf_get_from_surface(&surface, 0, 0, size, size)
}

fn draw(cr: &cairo::Context, icon: Icon, size: i32, y: f64, color: &gdk::RGBA) {
    let scale = f64::from(size) / 24.0;
    let _ = cr.save();
    cr.translate(0.0, y);
    cr.scale(scale, scale);
    cr.set_source_rgba(color.red(), color.green(), color.blue(), color.alpha());
    cr.set_line_width(1.8);
    cr.set_line_cap(gtk::cairo::LineCap::Round);
    cr.set_line_join(gtk::cairo::LineJoin::Round);

    match icon {
        Icon::Upload | Icon::Download => {
            cr.move_to(4.0, 15.0);
            cr.line_to(4.0, 20.0);
            cr.line_to(20.0, 20.0);
            cr.line_to(20.0, 15.0);
            let (tip, end, shoulder) = match icon {
                Icon::Upload => (4.0, 15.0, 8.0),
                _ => (15.0, 4.0, 11.0),
            };
            cr.move_to(12.0, end);
            cr.line_to(12.0, tip);
            cr.move_to(8.0, shoulder);
            cr.line_to(12.0, tip);
            cr.line_to(16.0, shoulder);
        }
        Icon::Copy | Icon::CopyRich => {
            cr.rectangle(8.0, 7.0, 12.0, 13.0);
            cr.move_to(4.0, 16.0);
            cr.line_to(4.0, 3.0);
            cr.line_to(16.0, 3.0);
            if matches!(icon, Icon::CopyRich) {
                cr.move_to(11.5, 11.0);
                cr.line_to(16.5, 11.0);
                cr.move_to(11.5, 15.5);
                cr.line_to(16.5, 15.5);
            }
        }
        Icon::Terminal => {
            cr.move_to(5.0, 5.0);
            cr.line_to(19.0, 5.0);
            cr.curve_to(20.1, 5.0, 21.0, 5.9, 21.0, 7.0);
            cr.line_to(21.0, 17.0);
            cr.curve_to(21.0, 18.1, 20.1, 19.0, 19.0, 19.0);
            cr.line_to(5.0, 19.0);
            cr.curve_to(3.9, 19.0, 3.0, 18.1, 3.0, 17.0);
            cr.line_to(3.0, 7.0);
            cr.curve_to(3.0, 5.9, 3.9, 5.0, 5.0, 5.0);
            cr.close_path();
            cr.move_to(7.0, 9.0);
            cr.line_to(10.0, 12.0);
            cr.line_to(7.0, 15.0);
            cr.move_to(13.0, 15.0);
            cr.line_to(17.0, 15.0);
        }
        Icon::Conversation => {
            cr.move_to(3.0, 5.0);
            cr.line_to(21.0, 5.0);
            cr.line_to(21.0, 16.0);
            cr.line_to(10.0, 16.0);
            cr.line_to(5.0, 20.0);
            cr.line_to(5.0, 16.0);
            cr.line_to(3.0, 16.0);
            cr.close_path();
            cr.move_to(7.5, 10.5);
            cr.line_to(16.5, 10.5);
        }
        Icon::TerminalDrawer => {
            cr.rectangle(3.0, 4.0, 18.0, 16.0);
            cr.move_to(3.0, 11.0);
            cr.line_to(21.0, 11.0);
            cr.move_to(7.0, 14.0);
            cr.line_to(9.0, 16.0);
            cr.line_to(7.0, 18.0);
            cr.move_to(12.0, 18.0);
            cr.line_to(16.0, 18.0);
        }
        Icon::RemoteHost => {
            cr.move_to(10.0, 16.0);
            cr.line_to(5.0, 16.0);
            cr.curve_to(3.7, 16.0, 3.0, 15.3, 3.0, 14.0);
            cr.line_to(3.0, 5.5);
            cr.curve_to(3.0, 4.2, 3.7, 3.5, 5.0, 3.5);
            cr.line_to(17.0, 3.5);
            cr.curve_to(18.3, 3.5, 19.0, 4.2, 19.0, 5.5);
            cr.line_to(19.0, 9.7);
            cr.move_to(8.0, 16.0);
            cr.line_to(8.0, 19.0);
            cr.move_to(5.5, 19.0);
            cr.line_to(10.2, 19.0);
            cr.new_sub_path();
            cr.arc(17.0, 17.0, 4.8, 0.0, std::f64::consts::TAU);
            cr.move_to(16.0, 15.6);
            cr.line_to(14.6, 17.0);
            cr.line_to(16.0, 18.4);
            cr.move_to(18.0, 15.6);
            cr.line_to(19.4, 17.0);
            cr.line_to(18.0, 18.4);
        }
        Icon::Connect => {
            cr.move_to(2.5, 12.0);
            cr.line_to(6.0, 12.0);
            cr.move_to(12.5, 7.0);
            cr.line_to(10.0, 7.0);
            cr.curve_to(7.8, 7.0, 6.0, 8.8, 6.0, 11.0);
            cr.line_to(6.0, 13.0);
            cr.curve_to(6.0, 15.2, 7.8, 17.0, 10.0, 17.0);
            cr.line_to(12.5, 17.0);
            cr.close_path();
            cr.move_to(12.5, 10.0);
            cr.line_to(16.0, 10.0);
            cr.move_to(12.5, 14.0);
            cr.line_to(16.0, 14.0);
            cr.move_to(18.6, 6.0);
            cr.line_to(19.0, 6.0);
            cr.curve_to(20.4, 6.0, 21.5, 7.1, 21.5, 8.5);
            cr.line_to(21.5, 15.5);
            cr.curve_to(21.5, 16.9, 20.4, 18.0, 19.0, 18.0);
            cr.line_to(18.6, 18.0);
        }
        Icon::ExternalLink => {
            cr.move_to(10.5, 5.0);
            cr.line_to(6.5, 5.0);
            cr.curve_to(5.1, 5.0, 4.0, 6.1, 4.0, 7.5);
            cr.line_to(4.0, 17.5);
            cr.curve_to(4.0, 18.9, 5.1, 20.0, 6.5, 20.0);
            cr.line_to(16.5, 20.0);
            cr.curve_to(17.9, 20.0, 19.0, 18.9, 19.0, 17.5);
            cr.line_to(19.0, 13.5);
            cr.move_to(12.0, 12.0);
            cr.line_to(20.0, 4.0);
            cr.move_to(14.5, 4.0);
            cr.line_to(20.0, 4.0);
            cr.line_to(20.0, 9.5);
        }
        Icon::Plus => {
            cr.move_to(12.0, 4.5);
            cr.line_to(12.0, 19.5);
            cr.move_to(4.5, 12.0);
            cr.line_to(19.5, 12.0);
        }
        Icon::Close => {
            cr.move_to(6.0, 6.0);
            cr.line_to(18.0, 18.0);
            cr.move_to(18.0, 6.0);
            cr.line_to(6.0, 18.0);
        }
        Icon::More => {
            for x in [5.5, 12.0, 18.5] {
                cr.new_sub_path();
                cr.arc(x, 12.0, 1.3, 0.0, std::f64::consts::TAU);
            }
            let _ = cr.fill();
        }
        Icon::Folder => {
            cr.move_to(3.0, 19.0);
            cr.line_to(3.0, 6.0);
            cr.line_to(10.0, 6.0);
            cr.line_to(12.5, 8.5);
            cr.line_to(21.0, 8.5);
            cr.line_to(21.0, 19.0);
            cr.close_path();
        }
        Icon::File => {
            cr.move_to(6.0, 3.5);
            cr.line_to(14.0, 3.5);
            cr.line_to(19.0, 8.5);
            cr.line_to(19.0, 20.5);
            cr.line_to(6.0, 20.5);
            cr.close_path();
            cr.move_to(14.0, 3.5);
            cr.line_to(14.0, 8.5);
            cr.line_to(19.0, 8.5);
        }
        Icon::Link => {
            cr.move_to(6.0, 18.0);
            cr.line_to(18.0, 6.0);
            cr.move_to(9.0, 6.0);
            cr.line_to(18.0, 6.0);
            cr.line_to(18.0, 15.0);
        }
        Icon::Attachment => {
            cr.move_to(9.0, 13.5);
            cr.line_to(15.0, 7.5);
            cr.curve_to(17.2, 5.3, 20.5, 8.6, 18.3, 10.8);
            cr.line_to(10.5, 18.6);
            cr.curve_to(6.9, 22.2, 1.8, 17.1, 5.4, 13.5);
            cr.line_to(14.5, 4.4);
        }
        Icon::Shield => {
            cr.move_to(12.0, 3.0);
            cr.line_to(19.0, 6.0);
            cr.line_to(19.0, 11.5);
            cr.curve_to(19.0, 16.0, 16.0, 19.0, 12.0, 21.0);
            cr.curve_to(8.0, 19.0, 5.0, 16.0, 5.0, 11.5);
            cr.line_to(5.0, 6.0);
            cr.close_path();
            cr.move_to(9.0, 11.5);
            cr.line_to(11.0, 13.5);
            cr.line_to(15.0, 9.5);
        }
        Icon::ChevronDown => {
            cr.set_line_width(2.5);
            cr.move_to(5.0, 9.0);
            cr.line_to(12.0, 16.0);
            cr.line_to(19.0, 9.0);
        }
        Icon::ChevronRight => {
            cr.set_line_width(2.5);
            cr.move_to(9.0, 5.0);
            cr.line_to(16.0, 12.0);
            cr.line_to(9.0, 19.0);
        }
        Icon::Bolt => {
            cr.move_to(13.5, 2.5);
            cr.line_to(5.0, 13.5);
            cr.line_to(11.0, 13.5);
            cr.line_to(10.5, 21.5);
            cr.line_to(19.0, 10.5);
            cr.line_to(13.0, 10.5);
            cr.close_path();
        }
        Icon::Up => {
            cr.move_to(12.0, 19.5);
            cr.line_to(12.0, 4.5);
            cr.move_to(6.0, 10.5);
            cr.line_to(12.0, 4.5);
            cr.line_to(18.0, 10.5);
        }
        Icon::Stop => {
            cr.rectangle(6.0, 6.0, 12.0, 12.0);
            let _ = cr.fill();
        }
        Icon::Pause => {
            cr.rectangle(6.0, 5.0, 4.0, 14.0);
            cr.rectangle(14.0, 5.0, 4.0, 14.0);
            let _ = cr.fill();
        }
        Icon::Refresh => {
            cr.arc(12.0, 12.0, 7.2, 0.0, 5.5);
            cr.move_to(17.1, 2.8);
            cr.line_to(17.1, 6.9);
            cr.line_to(13.0, 6.9);
        }
        Icon::Search => {
            cr.arc(10.2, 10.2, 5.8, 0.0, std::f64::consts::TAU);
            cr.move_to(14.7, 14.7);
            cr.line_to(20.0, 20.0);
        }
        Icon::Activity => {
            cr.move_to(3.5, 12.0);
            cr.line_to(7.0, 12.0);
            cr.line_to(10.0, 5.5);
            cr.line_to(14.0, 18.5);
            cr.line_to(17.0, 12.0);
            cr.line_to(20.5, 12.0);
        }
        Icon::Book => {
            cr.move_to(12.0, 5.5);
            cr.curve_to(9.5, 3.0, 6.5, 3.5, 3.5, 4.5);
            cr.line_to(3.5, 18.0);
            cr.curve_to(6.5, 17.0, 9.5, 17.0, 12.0, 19.5);
            cr.curve_to(14.5, 17.0, 17.5, 17.0, 20.5, 18.0);
            cr.line_to(20.5, 4.5);
            cr.curve_to(17.5, 3.5, 14.5, 3.0, 12.0, 5.5);
            cr.line_to(12.0, 19.5);
        }
        Icon::Edit => {
            cr.move_to(4.0, 20.0);
            cr.line_to(5.5, 14.5);
            cr.line_to(16.5, 3.5);
            cr.line_to(20.5, 7.5);
            cr.line_to(9.5, 18.5);
            cr.close_path();
            cr.move_to(14.0, 6.0);
            cr.line_to(18.0, 10.0);
        }
        Icon::Globe => {
            cr.arc(12.0, 12.0, 8.0, 0.0, std::f64::consts::TAU);
            cr.new_sub_path();
            cr.move_to(4.0, 12.0);
            cr.line_to(20.0, 12.0);
            cr.new_sub_path();
            cr.move_to(12.0, 4.0);
            cr.curve_to(17.0, 8.0, 17.0, 16.0, 12.0, 20.0);
            cr.curve_to(7.0, 16.0, 7.0, 8.0, 12.0, 4.0);
        }
        Icon::Tool => {
            cr.move_to(21.0, 7.0);
            cr.line_to(17.0, 11.0);
            cr.line_to(13.0, 7.0);
            cr.line_to(17.0, 3.0);
            cr.curve_to(12.0, 2.0, 9.0, 6.0, 10.5, 10.0);
            cr.line_to(4.0, 16.5);
            cr.curve_to(2.0, 18.5, 5.5, 22.0, 7.5, 20.0);
            cr.line_to(14.0, 13.5);
            cr.curve_to(18.5, 15.0, 22.0, 11.5, 21.0, 7.0);
        }
    }
    let _ = cr.stroke();
    let _ = cr.restore();
}

pub fn button(icon: Icon, label: &str, tooltip: &str) -> gtk::Button {
    let button = gtk::Button::builder().tooltip_text(tooltip).build();
    button.style_context().add_class("quiet-button");
    let icon = widget(icon, 16);
    icon.show();
    button.add(&icon);
    if let Some(accessible) = button.accessible() {
        accessible.set_name(label);
    }
    button
}
