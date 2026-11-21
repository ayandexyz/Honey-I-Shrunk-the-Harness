//! jcode: GPU bindings reused from frame to frame.
//!
//! Upstream creates a bind group for each kind of instance data and for each
//! sprite batch's texture on every frame, and writes each allocation to the
//! queue on its own, each write through a staging buffer of its own. In a live
//! profile of Jcode Desktop on Vulkan those were about half of the renderer's
//! CPU time. Here:
//!
//! - the whole instance buffer is bound once, and draws address their records
//!   absolutely through their first instance (or first vertex), as the WebGL
//!   texture transport already does. The bind group is made again only when
//!   the instance data is replaced, by growing or by device recovery;
//! - a texture's bind group is kept while frames draw from the texture, and
//!   let go one frame after they stop, so a freed atlas page or a path target
//!   replaced on resize is not held on to;
//! - the instance records of a frame are written to the queue in one write
//!   just before the frame is submitted. Queue writes land before the commands
//!   submitted after them, so the frame reads what it wrote, as before.

use crate::wgpu_renderer::{
    INSTANCE_TEXTURE_TEXEL_SIZE, InstanceBinding, InstanceData, WgpuRenderer, least_common_multiple,
};
use anyhow::{Context as _, Result};
use collections::FxHashMap;
use std::cell::RefCell;

#[derive(Default)]
pub(super) struct FrameBindings {
    /// Counts the frames recorded, to tell which textures the last one used.
    frame: u64,
    /// The instance data the bind group binds, and the bind group.
    instances: Option<(InstanceKey, wgpu::BindGroup)>,
    /// The bytes allocated this frame from `pending_offset` on, not written yet.
    pending: Vec<u8>,
    pending_offset: u64,
    /// Each texture's bind group, with the frame that last drew from it.
    textures: RefCell<FxHashMap<wgpu::TextureView, (wgpu::BindGroup, u64)>>,
}

#[derive(PartialEq)]
enum InstanceKey {
    Buffer(wgpu::Buffer),
    Texture(wgpu::TextureView),
}

impl FrameBindings {
    /// Starts recording a frame: forgets what an abandoned frame allocated, and
    /// lets go of texture bind groups the last frame did not draw from.
    pub(super) fn begin_frame(&mut self) {
        self.frame += 1;
        self.pending.clear();
        let frame = self.frame;
        self.textures
            .get_mut()
            .retain(|_, (_, used)| *used + 1 >= frame);
    }
}

/// Allocates `instances` in the frame's instance data. See the module docs.
pub(super) fn write_instance_binding<T>(
    renderer: &mut WgpuRenderer,
    instance_offset: &mut u64,
    instances: &[T],
) -> Result<InstanceBinding> {
    let data = unsafe { WgpuRenderer::instance_bytes(instances) };
    if data.is_empty() {
        // Nothing is drawn from an empty allocation, so it takes no space.
        return Ok(InstanceBinding {
            bind_group: instance_bind_group(renderer),
            first_instance: 0,
        });
    }
    let stride = (std::mem::size_of::<T>() as u64).max(1);
    let webgl = renderer.uses_webgl_instance_data;
    let (alignment, size) = if webgl {
        // The texture transport writes whole texels, so an allocation also
        // starts and ends on a texel boundary.
        (
            least_common_multiple(renderer.instance_data_alignment, stride),
            (data.len() as u64).next_multiple_of(INSTANCE_TEXTURE_TEXEL_SIZE),
        )
    } else {
        // The whole buffer is bound: an allocation only has to start on a
        // whole record for its first instance to address it.
        (stride, data.len() as u64)
    };
    let mut offset = instance_offset.next_multiple_of(alignment);
    if offset + size > renderer.instance_data_capacity {
        // What was allocated so far belongs in the data being replaced, which
        // the bind groups of earlier draws keep alive.
        flush(renderer);
        renderer.grow_instance_data(size)?;
        offset = 0;
    }
    *instance_offset = offset + size;
    let first_instance =
        u32::try_from(offset / stride).context("instance index exceeds u32 range")?;
    if webgl {
        WgpuRenderer::write_instance_texture(renderer.resources(), offset, data);
    } else {
        let bindings = &mut renderer.bindings;
        if bindings.pending.is_empty() {
            bindings.pending_offset = offset;
        }
        // Alignment padding between allocations is written as zeros.
        let start = (offset - bindings.pending_offset) as usize;
        bindings.pending.resize(start, 0);
        bindings.pending.extend_from_slice(data);
    }
    Ok(InstanceBinding {
        bind_group: instance_bind_group(renderer),
        first_instance,
    })
}

/// Writes the instance records allocated since the last write to the queue.
pub(super) fn flush(renderer: &mut WgpuRenderer) {
    if renderer.bindings.pending.is_empty() {
        return;
    }
    let resources = renderer.resources();
    if let InstanceData::Storage(buffer) = &resources.instance_data {
        resources.queue.write_buffer(
            buffer,
            renderer.bindings.pending_offset,
            &renderer.bindings.pending,
        );
    }
    renderer.bindings.pending.clear();
}

/// The bind group of the whole instance data.
fn instance_bind_group(renderer: &mut WgpuRenderer) -> wgpu::BindGroup {
    let resources = renderer.resources();
    let key = match &resources.instance_data {
        InstanceData::Storage(buffer) => InstanceKey::Buffer(buffer.clone()),
        InstanceData::Texture { view, .. } => InstanceKey::Texture(view.clone()),
    };
    if let Some((bound, bind_group)) = &renderer.bindings.instances
        && *bound == key
    {
        return bind_group.clone();
    }
    let bind_group = resources
        .device
        .create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("instance_data_bind_group"),
            layout: &resources.bind_group_layouts.instances,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: match &resources.instance_data {
                    InstanceData::Storage(buffer) => buffer.as_entire_binding(),
                    InstanceData::Texture { view, .. } => wgpu::BindingResource::TextureView(view),
                },
            }],
        });
    renderer.bindings.instances = Some((key, bind_group.clone()));
    bind_group
}

/// The bind group sampling `texture_view` with the atlas sampler.
pub(super) fn texture_bind_group(
    renderer: &WgpuRenderer,
    label: &str,
    texture_view: &wgpu::TextureView,
) -> wgpu::BindGroup {
    let frame = renderer.bindings.frame;
    let mut textures = renderer.bindings.textures.borrow_mut();
    if let Some((bind_group, used)) = textures.get_mut(texture_view) {
        *used = frame;
        return bind_group.clone();
    }
    let resources = renderer.resources();
    let bind_group = resources
        .device
        .create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some(label),
            layout: &resources.bind_group_layouts.texture,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(texture_view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(&resources.atlas_sampler),
                },
            ],
        });
    textures.insert(texture_view.clone(), (bind_group.clone(), frame));
    bind_group
}
