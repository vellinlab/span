use gtk::glib;
use gtk::prelude::*;

#[derive(Clone, Copy)]
pub enum Icon {
    Terminal,
    Server,
    Connect,
    Plus,
    Close,
    More,
}

pub fn widget(icon: Icon, size: i32) -> gtk::DrawingArea {
    let area = gtk::DrawingArea::new();
    area.set_size_request(size, size);
    area.set_halign(gtk::Align::Center);
    area.set_valign(gtk::Align::Center);
    area.connect_draw(move |area, cr| {
        let style = area.style_context();
        let color = style.color(area.state_flags());
        let scale = f64::from(size) / 24.0;
        let _ = cr.save();
        cr.scale(scale, scale);
        cr.set_source_rgba(color.red(), color.green(), color.blue(), color.alpha());
        cr.set_line_width(1.8);
        cr.set_line_cap(gtk::cairo::LineCap::Round);
        cr.set_line_join(gtk::cairo::LineJoin::Round);

        match icon {
            Icon::Terminal => {
                cr.rectangle(3.0, 5.0, 18.0, 14.0);
                cr.move_to(7.0, 9.0);
                cr.line_to(10.0, 12.0);
                cr.line_to(7.0, 15.0);
                cr.move_to(13.0, 15.0);
                cr.line_to(17.0, 15.0);
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
        }
        let _ = cr.stroke();
        let _ = cr.restore();
        glib::Propagation::Proceed
    });
    area
}
