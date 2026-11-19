use gtk::prelude::*;
use gtk::{cairo, gdk, gdk_pixbuf, glib};

#[derive(Clone, Copy)]
pub enum Icon {
    Terminal,
    Conversation,
    TerminalDrawer,
    Server,
    Connect,
    Plus,
    Close,
    More,
    Folder,
    File,
    Link,
    Attachment,
    ChevronDown,
    Bolt,
    Up,
    Stop,
    Pause,
    Refresh,
    Upload,
    Download,
    Copy,
    CopyRich,
}

pub fn widget(icon: Icon, size: i32) -> gtk::DrawingArea {
    let area = gtk::DrawingArea::new();
    area.set_size_request(size, size);
    area.set_halign(gtk::Align::Center);
    area.set_valign(gtk::Align::Center);
    area.connect_draw(move |area, cr| {
        let style = area.style_context();
        let color = style.color(area.state_flags());
        draw(cr, icon, size, &color);
        glib::Propagation::Proceed
    });
    area
}

pub fn pixbuf(icon: Icon, size: i32, color: &gdk::RGBA) -> Option<gdk_pixbuf::Pixbuf> {
    let surface = cairo::ImageSurface::create(cairo::Format::ARgb32, size, size).ok()?;
    {
        let cr = cairo::Context::new(&surface).ok()?;
        draw(&cr, icon, size, color);
    }
    gdk::pixbuf_get_from_surface(&surface, 0, 0, size, size)
}

fn draw(cr: &cairo::Context, icon: Icon, size: i32, color: &gdk::RGBA) {
    let scale = f64::from(size) / 24.0;
    let _ = cr.save();
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
            cr.rectangle(3.0, 5.0, 18.0, 14.0);
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
        Icon::Server => {
            for y in [4.5, 13.5] {
                cr.rectangle(3.0, y, 18.0, 6.0);
                cr.move_to(6.5, y + 3.0);
                cr.line_to(7.5, y + 3.0);
                cr.move_to(13.5, y + 3.0);
                cr.line_to(17.5, y + 3.0);
            }
        }
        Icon::Connect => {
            cr.move_to(4.0, 8.0);
            cr.line_to(20.0, 8.0);
            cr.move_to(16.0, 4.0);
            cr.line_to(20.0, 8.0);
            cr.line_to(16.0, 12.0);
            cr.move_to(20.0, 16.0);
            cr.line_to(4.0, 16.0);
            cr.move_to(8.0, 12.0);
            cr.line_to(4.0, 16.0);
            cr.line_to(8.0, 20.0);
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
        Icon::ChevronDown => {
            cr.set_line_width(2.5);
            cr.move_to(5.0, 9.0);
            cr.line_to(12.0, 16.0);
            cr.line_to(19.0, 9.0);
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
