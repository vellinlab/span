use gtk::cairo;
use gtk::glib::{self, ffi, gobject_ffi, translate::from_glib_full};
use std::ffi::c_int;
use std::ptr::{NonNull, null_mut};

#[repr(C)]
struct RsvgHandle {
    _private: [u8; 0],
}

#[repr(C)]
#[derive(Default)]
struct Dimensions {
    width: c_int,
    height: c_int,
    em: f64,
    ex: f64,
}

#[link(name = "rsvg-2")]
unsafe extern "C" {
    fn rsvg_handle_new_from_data(
        data: *const u8,
        len: usize,
        error: *mut *mut ffi::GError,
    ) -> *mut RsvgHandle;
    fn rsvg_handle_set_dpi(handle: *mut RsvgHandle, dpi: f64);
    fn rsvg_handle_get_dimensions(handle: *mut RsvgHandle, dimensions: *mut Dimensions);
    // EL8 supplies librsvg 2.42, which predates rsvg_handle_render_document.
    fn rsvg_handle_render_cairo(
        handle: *mut RsvgHandle,
        cr: *mut cairo::ffi::cairo_t,
    ) -> ffi::gboolean;
}

pub struct Svg {
    handle: NonNull<RsvgHandle>,
    size: (i32, i32),
}

impl Svg {
    pub fn new(bytes: &[u8]) -> Result<Self, String> {
        let mut error = null_mut();
        // Omit a base URI so SVGs fetched over SFTP cannot resolve external files.
        let handle = unsafe { rsvg_handle_new_from_data(bytes.as_ptr(), bytes.len(), &mut error) };
        let Some(handle) = NonNull::new(handle) else {
            if error.is_null() {
                return Err("无法读取 SVG。".into());
            }
            let error: glib::Error = unsafe { from_glib_full(error) };
            return Err(format!("无法读取 SVG：{error}"));
        };
        let mut svg = Self {
            handle,
            size: (0, 0),
        };
        let mut dimensions = Dimensions::default();
        unsafe {
            rsvg_handle_set_dpi(handle.as_ptr(), 96.0);
            rsvg_handle_get_dimensions(handle.as_ptr(), &mut dimensions);
        }
        if dimensions.width <= 0 || dimensions.height <= 0 {
            return Err("SVG 没有可预览的尺寸。".into());
        }
        svg.size = (dimensions.width, dimensions.height);
        Ok(svg)
    }

    pub fn dimensions(&self) -> (i32, i32) {
        self.size
    }

    pub fn draw(&self, cr: &cairo::Context) -> bool {
        unsafe { rsvg_handle_render_cairo(self.handle.as_ptr(), cr.to_raw_none()) != 0 }
    }
}

impl Drop for Svg {
    fn drop(&mut self) {
        unsafe { gobject_ffi::g_object_unref(self.handle.as_ptr().cast()) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn svg_resolves_detail_below_a_pixel_when_zoomed() {
        let svg = Svg::new(
            br#"<svg xmlns="http://www.w3.org/2000/svg" width="64" height="48">
          <rect fill="white" x="16.25" y="2" width="0.5" height="44"/>
        </svg>"#,
        )
        .unwrap();
        assert_eq!(svg.dimensions(), (64, 48));
        let mut surface = cairo::ImageSurface::create(cairo::Format::ARgb32, 256, 192).unwrap();
        {
            let cr = cairo::Context::new(&surface).unwrap();
            cr.scale(4.0, 4.0);
            assert!(svg.draw(&cr));
        }
        let stride = surface.stride() as usize;
        let data = surface.data().unwrap();
        let pixel = |column| {
            let start = 20 * stride + 4 * column;
            u32::from_ne_bytes(data[start..start + 4].try_into().unwrap())
        };
        assert_eq!(
            (pixel(64), pixel(65), pixel(66), pixel(67)),
            (0, u32::MAX, u32::MAX, 0)
        );
        assert!(Svg::new(b"broken SVG").is_err());
    }
}
