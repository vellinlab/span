use gtk::glib;
use gtk::prelude::*;

const MAX_WIDTH: i32 = 800;

glib::wrapper! {
    pub struct ReadingColumn(ObjectSubclass<imp::ReadingColumn>)
        @extends gtk::Box, gtk::Container, gtk::Widget,
        @implements gtk::Buildable, gtk::Orientable;
}

pub fn new(spacing: i32) -> gtk::Box {
    glib::Object::builder::<ReadingColumn>()
        .property("orientation", gtk::Orientation::Vertical)
        .property("spacing", spacing)
        .build()
        .upcast()
}

mod imp {
    use super::{MAX_WIDTH, glib};
    use gtk::subclass::prelude::*;

    #[derive(Default)]
    pub struct ReadingColumn;

    #[glib::object_subclass]
    impl ObjectSubclass for ReadingColumn {
        const NAME: &'static str = "SpanReadingColumn";
        type Type = super::ReadingColumn;
        type ParentType = gtk::Box;
    }

    impl ObjectImpl for ReadingColumn {}
    impl ContainerImpl for ReadingColumn {}
    impl BoxImpl for ReadingColumn {}

    impl WidgetImpl for ReadingColumn {
        fn adjust_size_allocation(
            &self,
            orientation: gtk::Orientation,
            minimum: &mut i32,
            natural: &mut i32,
            position: &mut i32,
            size: &mut i32,
        ) {
            self.parent_adjust_size_allocation(orientation, minimum, natural, position, size);
            if orientation == gtk::Orientation::Horizontal && *size > MAX_WIDTH {
                *position += (*size - MAX_WIDTH) / 2;
                *size = MAX_WIDTH;
            }
        }
    }
}
