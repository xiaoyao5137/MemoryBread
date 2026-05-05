//! 截图采集与 JPEG 压缩存储
//!
//! 生产环境：使用 `xcap` crate 采集全屏截图，
//! 转换为 JPEG（质量可配置），存储到时间戳命名的文件。
//!
//! 测试环境：`capture_and_save` 返回 None，不调用系统 API。

#[cfg(test)]
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
#[cfg(test)]
use std::sync::{Mutex, OnceLock};

use image::{imageops::FilterType, DynamicImage};

use super::CaptureError;

// ─────────────────────────────────────────────────────────────────────────────
// 公共类型
// ─────────────────────────────────────────────────────────────────────────────

/// 截图保存结果
#[derive(Debug, Clone)]
pub struct ScreenshotResult {
    /// 相对于 captures_dir 的路径（写入数据库 screenshot_path 字段）
    pub relative_path: String,
    /// 截图文件的完整磁盘路径
    pub full_path: PathBuf,
    /// 感知哈希（dHash）用于近似去重
    pub dhash: u64,
    /// 图像宽度（像素）
    pub width: u32,
    /// 图像高度（像素）
    pub height: u32,
    /// JPEG 文件大小（字节）
    pub file_size: u64,
}

// ─────────────────────────────────────────────────────────────────────────────
// 公共 API
// ─────────────────────────────────────────────────────────────────────────────

/// 采集主显示器截图并以 JPEG 格式存储。
///
/// 返回 `Ok(None)` 表示无可用显示器（无头服务器 / 测试环境）。
pub fn capture_and_save(
    captures_dir: &Path,
    quality: u8,
) -> Result<Option<ScreenshotResult>, CaptureError> {
    #[cfg(not(test))]
    {
        capture_real(captures_dir, quality)
    }
    #[cfg(test)]
    {
        capture_test(captures_dir, quality)
    }
}

/// 生成截图文件的相对路径。
///
/// 格式：`screenshots/{timestamp_ms}.jpg`
pub fn make_relative_path(ts_ms: i64) -> String {
    format!("screenshots/{}.jpg", ts_ms)
}

/// 计算图像的 64-bit dHash（difference hash）。
pub fn compute_dhash64(image: &DynamicImage) -> u64 {
    let resized = image
        .resize_exact(9, 8, FilterType::Triangle)
        .grayscale()
        .to_luma8();

    let mut hash = 0u64;
    for y in 0..8 {
        for x in 0..8 {
            let left = resized.get_pixel(x, y)[0];
            let right = resized.get_pixel(x + 1, y)[0];
            hash <<= 1;
            if left > right {
                hash |= 1;
            }
        }
    }

    hash
}

/// 计算两个 dHash 的汉明距离。
pub fn hamming_distance(a: u64, b: u64) -> u32 {
    (a ^ b).count_ones()
}

#[cfg(test)]
#[derive(Debug, Clone)]
struct TestScreenshotFixture {
    width: u32,
    height: u32,
    pixels: Vec<u8>,
}

#[cfg(test)]
fn test_screenshot_queue() -> &'static Mutex<VecDeque<TestScreenshotFixture>> {
    static TEST_SCREENSHOT_QUEUE: OnceLock<Mutex<VecDeque<TestScreenshotFixture>>> =
        OnceLock::new();
    TEST_SCREENSHOT_QUEUE.get_or_init(|| Mutex::new(VecDeque::new()))
}

#[cfg(test)]
pub(crate) fn clear_test_screenshots() {
    if let Ok(mut guard) = test_screenshot_queue().lock() {
        guard.clear();
    }
}

#[cfg(test)]
pub(crate) fn push_test_screenshot(width: u32, height: u32, pixels: Vec<u8>) {
    let fixture = TestScreenshotFixture {
        width,
        height,
        pixels,
    };
    test_screenshot_queue().lock().unwrap().push_back(fixture);
}

#[cfg(test)]
pub(crate) fn push_test_screenshot_from_image(image: &DynamicImage) {
    let rgb = image.to_rgb8();
    push_test_screenshot(rgb.width(), rgb.height(), rgb.into_raw());
}

// ─────────────────────────────────────────────────────────────────────────────
// 真实截图实现（仅非测试编译）
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(not(test))]
fn capture_real(
    captures_dir: &Path,
    quality: u8,
) -> Result<Option<ScreenshotResult>, CaptureError> {
    use image::codecs::jpeg::JpegEncoder;
    use image::imageops;
    use std::fs;
    use std::io::BufWriter;
    use std::time::{SystemTime, UNIX_EPOCH};
    use xcap::Monitor;

    let monitors = Monitor::all().map_err(|e| CaptureError::ScreenshotFailed(e.to_string()))?;

    if monitors.is_empty() {
        return Ok(None);
    }

    let ts_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;

    // 采集所有显示器并水平拼接
    let mut combined_image: Option<DynamicImage> = None;

    for (i, monitor) in monitors.iter().enumerate() {
        let rgba_image = match monitor.capture_image() {
            Ok(img) => img,
            Err(e) => {
                tracing::warn!("显示器 {} 截图失败: {}", i, e);
                continue;
            }
        };

        let dynamic = DynamicImage::ImageRgba8(rgba_image);

        combined_image = Some(match combined_image {
            None => dynamic,
            Some(existing) => {
                // 水平拼接：将新图像放在右侧
                let total_width = existing.width() + dynamic.width();
                let total_height = existing.height().max(dynamic.height());

                let mut combined = DynamicImage::new_rgba8(total_width, total_height);
                imageops::overlay(&mut combined, &existing, 0, 0);
                imageops::overlay(&mut combined, &dynamic, existing.width() as i64, 0);
                combined
            }
        });
    }

    let combined_image = match combined_image {
        Some(img) => img,
        None => return Ok(None),
    };

    let width = combined_image.width();
    let height = combined_image.height();

    let relative_path = make_relative_path(ts_ms);
    let full_path = captures_dir.join(&relative_path);

    // 确保父目录存在
    if let Some(parent) = full_path.parent() {
        fs::create_dir_all(parent)?;
    }

    let dhash = compute_dhash64(&combined_image);
    let rgb_image = combined_image.into_rgb8();

    // 编码为 JPEG（指定质量）
    let file = fs::File::create(&full_path)?;
    let writer = BufWriter::new(file);
    let mut encoder = JpegEncoder::new_with_quality(writer, quality);
    encoder
        .encode_image(&DynamicImage::ImageRgb8(rgb_image))
        .map_err(|e| CaptureError::ImageError(e.to_string()))?;
    drop(encoder);

    let file_size = fs::metadata(&full_path)?.len();

    Ok(Some(ScreenshotResult {
        relative_path,
        full_path,
        dhash,
        width,
        height,
        file_size,
    }))
}

#[cfg(test)]
fn capture_test(
    captures_dir: &Path,
    quality: u8,
) -> Result<Option<ScreenshotResult>, CaptureError> {
    use image::{codecs::jpeg::JpegEncoder, RgbImage};
    use std::fs;
    use std::io::BufWriter;
    use std::time::{SystemTime, UNIX_EPOCH};

    let fixture = match test_screenshot_queue().lock().unwrap().pop_front() {
        Some(fixture) => fixture,
        None => return Ok(None),
    };

    let TestScreenshotFixture {
        width,
        height,
        pixels,
    } = fixture;
    let rgb_image = RgbImage::from_raw(width, height, pixels)
        .ok_or_else(|| CaptureError::ImageError("invalid test screenshot pixels".to_string()))?;

    let ts_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;

    let relative_path = make_relative_path(ts_ms);
    let full_path = captures_dir.join(&relative_path);

    if let Some(parent) = full_path.parent() {
        fs::create_dir_all(parent)?;
    }

    let dynamic = DynamicImage::ImageRgb8(rgb_image);
    let dhash = compute_dhash64(&dynamic);

    let file = fs::File::create(&full_path)?;
    let writer = BufWriter::new(file);
    let mut encoder = JpegEncoder::new_with_quality(writer, quality);
    encoder
        .encode_image(&dynamic)
        .map_err(|e| CaptureError::ImageError(e.to_string()))?;
    drop(encoder);

    let file_size = fs::metadata(&full_path)?.len();

    Ok(Some(ScreenshotResult {
        relative_path,
        full_path,
        dhash,
        width,
        height,
        file_size,
    }))
}

// ─────────────────────────────────────────────────────────────────────────────
// 测试
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use image::{DynamicImage, GrayImage, Luma, RgbImage};
    use tempfile::tempdir;

    #[test]
    fn test_capture_returns_none_in_test_env() {
        clear_test_screenshots();
        let dir = tempdir().unwrap();
        let result = capture_and_save(dir.path(), 80).unwrap();
        assert!(result.is_none(), "测试环境未注入截图时不应产生截图");
    }

    #[test]
    fn test_make_relative_path_format() {
        let path = make_relative_path(1_700_000_000_000);
        assert!(path.starts_with("screenshots/"), "应以 screenshots/ 开头");
        assert!(path.ends_with(".jpg"), "应以 .jpg 结尾");
        assert!(path.contains("1700000000000"), "应包含时间戳");
    }

    #[test]
    fn test_make_relative_path_unique() {
        // 不同时间戳应生成不同路径
        let p1 = make_relative_path(1_000_000_000);
        let p2 = make_relative_path(1_000_000_001);
        assert_ne!(p1, p2);
    }

    fn gradient_image(offset: u8) -> DynamicImage {
        let mut image = GrayImage::new(64, 64);
        for y in 0..64 {
            for x in 0..64 {
                let value = x as u8 ^ offset ^ ((y as u8) >> 2);
                image.put_pixel(x, y, Luma([value]));
            }
        }
        DynamicImage::ImageLuma8(image)
    }

    #[test]
    fn test_compute_dhash64_same_image_same_hash() {
        let image = gradient_image(0);
        let hash1 = compute_dhash64(&image);
        let hash2 = compute_dhash64(&image);
        assert_eq!(hash1, hash2);
    }

    #[test]
    fn test_hamming_distance_counts_bit_differences() {
        let hash = 0b1011u64;
        assert_eq!(hamming_distance(hash, hash), 0);
        assert_eq!(hamming_distance(hash, hash ^ 0b1), 1);
        assert_eq!(hamming_distance(hash, hash ^ 0b11), 2);
    }

    #[test]
    fn test_capture_test_returns_fixture_with_dhash() {
        clear_test_screenshots();
        let dir = tempdir().unwrap();
        let image = DynamicImage::ImageRgb8(RgbImage::from_fn(16, 16, |x, y| {
            image::Rgb([(x * 3) as u8, (y * 5) as u8, (x + y) as u8])
        }));
        let expected_hash = compute_dhash64(&image);
        push_test_screenshot_from_image(&image);

        let result = capture_and_save(dir.path(), 80).unwrap().unwrap();
        assert_eq!(result.dhash, expected_hash);
        assert!(result.full_path.exists());
        assert!(result.file_size > 0);
    }

    /// 验证 image crate 的 JPEG 编码流程（不依赖系统截图 API）
    #[test]
    fn test_jpeg_encode_from_raw_pixels() {
        use image::codecs::jpeg::JpegEncoder;
        use image::{DynamicImage, RgbImage};
        use std::io::Cursor;

        // 创建 8×8 纯色 RGB 图像
        let width = 8u32;
        let height = 8u32;
        let pixels: Vec<u8> = (0..width * height * 3)
            .map(|i| match i % 3 {
                0 => 200, // R
                1 => 100, // G
                _ => 50,  // B
            })
            .collect();

        let rgb_image = RgbImage::from_raw(width, height, pixels).unwrap();
        let dynamic = DynamicImage::ImageRgb8(rgb_image);

        let mut buf = Cursor::new(Vec::<u8>::new());
        let mut encoder = JpegEncoder::new_with_quality(&mut buf, 80);
        encoder.encode_image(&dynamic).expect("JPEG 编码应成功");

        let bytes = buf.into_inner();
        assert!(!bytes.is_empty(), "JPEG 字节流不应为空");
        // JPEG 文件以 FF D8 开头
        assert_eq!(bytes[0], 0xFF, "JPEG 魔数第1字节");
        assert_eq!(bytes[1], 0xD8, "JPEG 魔数第2字节");
    }

    /// 验证 JPEG 文件可以被 image crate 重新解码
    #[test]
    fn test_jpeg_roundtrip() {
        use image::codecs::jpeg::JpegEncoder;
        use image::{DynamicImage, RgbImage};
        use std::io::Cursor;

        let width = 4u32;
        let height = 4u32;
        let pixels: Vec<u8> = vec![128u8; (width * height * 3) as usize];

        let rgb = RgbImage::from_raw(width, height, pixels).unwrap();
        let dyn_ = DynamicImage::ImageRgb8(rgb);

        let mut encoded = Cursor::new(Vec::<u8>::new());
        JpegEncoder::new_with_quality(&mut encoded, 90)
            .encode_image(&dyn_)
            .unwrap();

        // 重新解码
        encoded.set_position(0);
        let decoded = image::load(encoded, image::ImageFormat::Jpeg).unwrap();
        // JPEG 有损，尺寸应保持一致
        assert_eq!(decoded.width(), width);
        assert_eq!(decoded.height(), height);
    }
}
