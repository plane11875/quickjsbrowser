//! Synchronous static rendering boundary for Workers. JS executes in QuickJS.
//! `blitz-dom/floats` is required: CustomOutOfFlow boxes need its yield handler.
use std::collections::{BTreeSet, HashMap};
use std::cell::RefCell;
use std::sync::{Arc, Mutex, OnceLock};

use anyrender::{PaintScene as _, render_to_buffer};
use anyrender_vello_cpu::VelloCpuImageRenderer;
use blitz_dom::{DocumentConfig, StyleThreading, util::Color};
use blitz_html::HtmlDocument;
use blitz_traits::{net::{Bytes, NetHandler, NetProvider, Request}, shell::{ColorScheme, Viewport}};
use parley::{FontContext, fontique::GenericFamily};
use peniko::{Fill, kurbo::Rect};
use wasm_bindgen::prelude::*;

type Resources = Arc<Mutex<HashMap<String, Vec<u8>>>>;
static RESOURCES: OnceLock<Resources> = OnceLock::new();
static MISSED: OnceLock<Mutex<BTreeSet<String>>> = OnceLock::new();
static FONTS: OnceLock<Mutex<Vec<(String, Vec<u8>)>>> = OnceLock::new();
static LAST_PANIC: OnceLock<Mutex<String>> = OnceLock::new();
static GENERICS: OnceLock<Mutex<HashMap<String, Vec<String>>>> = OnceLock::new();

fn resources() -> &'static Resources { RESOURCES.get_or_init(Default::default) }
fn missed() -> &'static Mutex<BTreeSet<String>> { MISSED.get_or_init(Default::default) }
fn fonts() -> &'static Mutex<Vec<(String, Vec<u8>)>> { FONTS.get_or_init(Default::default) }
fn generics() -> &'static Mutex<HashMap<String, Vec<String>>> { GENERICS.get_or_init(Default::default) }

thread_local! {
    static LAYOUT: RefCell<Option<(String, String, u32, u32, HtmlDocument)>> = const { RefCell::new(None) };
}
fn invalidate_layout() { LAYOUT.with(|slot| *slot.borrow_mut() = None); }
struct CachedNet;
impl NetProvider for CachedNet {
    fn fetch(&self, _doc_id: usize, request: Request, handler: Box<dyn NetHandler>) {
        let url = request.url.to_string();
        let data = resources().lock().unwrap().get(&url).cloned();
        let data = match data {
            Some(data) => data,
            None if url.starts_with("data:") => data_url::DataUrl::process(&url)
                .ok().and_then(|u| u.decode_to_vec().ok()).map(|(b, _)| b).unwrap_or_default(),
            None => { missed().lock().unwrap().insert(url.clone()); Vec::new() }
        };
        // Always complete the resource callback. Missing resources are discovered
        // by the JS host and supplied before a fresh document is rendered.
        handler.bytes(url, Bytes::from(data));
    }
}

#[wasm_bindgen]
pub fn add_resource(url: &str, bytes: &[u8]) -> String {
    invalidate_layout();
    resources().lock().unwrap().insert(url.to_string(), bytes.to_vec());
    url.to_string()
}

#[wasm_bindgen]
pub fn clear_resources() {
    invalidate_layout();
    resources().lock().unwrap().clear();
    missed().lock().unwrap().clear();
}

#[wasm_bindgen]
pub fn missed_resources() -> js_sys::Array {
    missed().lock().unwrap().iter().map(|s| JsValue::from_str(s)).collect()
}

#[wasm_bindgen]
pub fn add_font(bytes: &[u8], family: &str) -> u32 {
    let mut registered = fonts().lock().unwrap();
    if !registered.iter().any(|(name, data)| name == family && data == bytes) {
        registered.push((family.to_string(), bytes.to_vec()));
    }
    registered.len() as u32
}

#[wasm_bindgen]
pub fn set_generic_lead(generic: &str, families: js_sys::Array) -> bool {
    let names = families.iter().filter_map(|v| v.as_string()).collect();
    generics().lock().unwrap().insert(generic.to_string(), names);
    true
}

fn font_context() -> FontContext {
    let mut context = FontContext::default();
    let mut aliases = HashMap::<String, Vec<_>>::new();
    for (alias, bytes) in fonts().lock().unwrap().iter() {
        let data = parley::fontique::Blob::new(Arc::new(bytes.clone()));
        let registered = context.collection.register_fonts(data, None);
        aliases.entry(alias.clone()).or_default().extend(registered.into_iter().map(|(id, _)| id));
    }
    for (generic, key, default) in [
        (GenericFamily::SansSerif, "sans-serif", vec!["sans", "sc", "jp"]),
        (GenericFamily::Serif, "serif", vec!["sans", "sc", "jp"]),
        (GenericFamily::Monospace, "monospace", vec!["mono", "sc", "jp"]),
    ] {
        let config = generics().lock().unwrap();
        let names = config.get(key).cloned().unwrap_or_else(|| default.into_iter().map(String::from).collect());
        let ids: Vec<_> = names.iter().flat_map(|name| aliases.get(name).into_iter().flatten().copied()).collect();
        context.collection.set_generic_families(generic, ids.into_iter());
    }
    context
}

#[wasm_bindgen]
pub fn render_png_rgba_no_js(html: &str, base_url: &str, width: u32, height: u32) -> Result<Vec<u8>, JsValue> {
    if width == 0 || height == 0 || width > 1920 || height > 4096 {
        return Err(JsValue::from_str("viewport must be 1..1920 by 1..4096"));
    }
    layout_query(html,base_url,width,height,"","",0.0,0.0)?;
    LAYOUT.with(|slot| {
        let mut slot=slot.borrow_mut();
        let document=&mut slot.as_mut().unwrap().4;
        let buffer=render_to_buffer::<VelloCpuImageRenderer,_>(|scene| {
            scene.fill(Fill::NonZero,Default::default(),Color::WHITE,Default::default(),&Rect::new(0.0,0.0,width as f64,height as f64));
            blitz_paint::paint_scene(scene,document,1.0,width,height,0,0);
        },width,height);
        Ok(buffer)
    })
}

#[wasm_bindgen]
pub fn last_panic() -> String { LAST_PANIC.get_or_init(Default::default).lock().unwrap().clone() }

#[wasm_bindgen(start)]
pub fn initialize() {
    std::panic::set_hook(Box::new(|info| {
        if let Ok(mut message) = LAST_PANIC.get_or_init(Default::default).lock() {
            *message = info.to_string();
        }
    }));
}

// Synchronous geometry/style bridge. Resource discovery needs layout, not pixels.
#[wasm_bindgen]
pub fn layout_query(html: &str, base_url: &str, width: u32, height: u32, selector: &str, property: &str, x: f32, y: f32) -> Result<JsValue, JsValue> {
    if width == 0 || height == 0 || width > 1920 || height > 4096 { return Err(JsValue::from_str("invalid viewport")); }
    LAYOUT.with(|slot| {
        let mut slot = slot.borrow_mut();
        let reusable = slot.as_ref().is_some_and(|(h,b,w,v,_)| h == html && b == base_url && *w == width && *v == height);
        if !reusable {
            slot.take(); // Release the previous document before allocating its replacement.
            missed().lock().unwrap().clear();
            let mut doc = HtmlDocument::from_html(html, DocumentConfig {
                base_url: Some(base_url.to_string()),
                viewport: Some(Viewport::new(width,height,1.0,ColorScheme::Light)),
                font_ctx: Some(font_context()), net_provider: Some(Arc::new(CachedNet)),
                style_threading: StyleThreading::Sequential, ..Default::default()
            });
            doc.resolve(0.0);
            *slot = Some((html.to_string(),base_url.to_string(),width,height,doc));
        }
        let doc = &slot.as_ref().unwrap().4;
        let result = js_sys::Object::new();
        let set = |key: &str, value: JsValue| { let _ = js_sys::Reflect::set(&result,&JsValue::from_str(key),&value); };
        set("cached",JsValue::from_bool(reusable));
        if property == "@hit" {
            let mut node = doc.element_from_point(x,y);
            while let Some(id) = node {
                let n = doc.get_node(id).unwrap();
                if let Some(tag) = n.attr("data-qjs-node".into()) { set("id",JsValue::from_str(tag));break; }
                node = n.parent;
            }
        } else if !selector.is_empty() {
            if let Some(id) = doc.query_selector(selector).map_err(|_|JsValue::from_str("invalid layout selector"))? {
                if let Some(rect) = doc.get_client_bounding_rect(id) {
                    for (k,v) in [("x",rect.x),("y",rect.y),("width",rect.width),("height",rect.height)] {set(k,JsValue::from_f64(v));}
                }
                if !property.is_empty() {set("value",JsValue::from_str(&doc.resolved_style_value(id,property)));}
            }
        }
        Ok(result.into())
    })
}
