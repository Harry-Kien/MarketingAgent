# V6 — Kiểm chứng render tiếng Việt cho hệ font

- **Trạng thái**: ✅ **VERIFIED**
- **Ngày thực hiện**: 2026-08-11, ~11:35–11:45 ICT (UTC+7)
- **Người thực hiện**: Claude Code
- **Gate liên quan**: V6 trong blueprint §Phụ lục B — chặn việc chốt font ở M0
- **Kết luận**: **Cả ba font đạt.** Giữ nguyên lựa chọn Archivo · Be Vietnam Pro · IBM Plex Mono, **kèm hai ràng buộc thiết kế bắt buộc** phát sinh từ kết quả đo (§4).

---

## 1. Phương pháp

| Hạng mục | Chi tiết |
|---|---|
| Harness | `docs/research/assets/font-harness.html` — trang tĩnh độc lập, **không nằm trong application source** |
| Nguồn font | Google Fonts CSS API v2, `display=block` |
| Trình duyệt | Chromium qua Playwright MCP |
| User agent | `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36` |
| Nền tảng render | **Windows NT 10.0 Win64** — đúng nền tảng Founder đang dùng |
| Viewport | 1440 × 900, screenshot full-page, `scale=device` |
| Font face đã tải | **44 face** (`document.fonts.size`) |
| Phục vụ trang | HTTP tĩnh `127.0.0.1:8791` bằng `node:http` built-in (`file:` bị Playwright chặn) |

**Không cài dependency nào.** Node dùng module built-in; Playwright dùng MCP server có sẵn; font tải từ CDN tại thời điểm render và **không** được thêm vào ứng dụng.

## 2. Bằng chứng

| File | Nội dung |
|---|---|
| `docs/research/assets/font-render-light.png` | Full-page, light background, 1425 × 2087 |
| `docs/research/assets/font-render-dark.png` | Full-page, dark background, 1425 × 2087 |
| `docs/research/assets/font-harness.html` | Harness tái lập được kết quả |

Harness gồm 9 mục: câu kiểm tra bắt buộc ở 5 cỡ chữ · 4 font weight × 3 họ chữ · chữ hoa/thường/số/ngoặc/phần trăm/tiền tệ · phủ toàn bộ dấu thanh · va chạm dấu ở line-height 1.0 · bảng dữ liệu + State Ribbon · fallback behavior · kiểm tra tự động.

## 3. Kết quả

### 3.1 Glyph coverage — `document.fonts.check()`

Cả **12/12** tổ hợp font × weight đạt cả ba tiêu chí:

| Font | Weight | Đã tải | Phủ dấu thanh (67 ký tự) | Phủ ₫ và ký hiệu |
|---|---|---|---|---|
| Archivo | 400, 500, 600, 700 | ✅ | ✅ | ✅ |
| Be Vietnam Pro | 400, 500, 600, 700 | ✅ | ✅ | ✅ |
| IBM Plex Mono | 400, 500, 600, 700 | ✅ | ✅ | ✅ |

### 3.2 Coverage per-glyph — đo bằng canvas, chặt hơn `fonts.check()`

`document.fonts.check(spec, text)` của Chromium trả `true` khá rộng rãi, nên tôi đo lại từng ký tự rủi ro bằng cách so chiều rộng khi render với font thật so với khi chỉ có fallback. Khác nhau ⇒ font thật cung cấp glyph.

Ký tự kiểm tra: `₫ ẳ ẵ ặ ữ ự ỡ ợ ỹ ỵ Đ đ Ữ Ự − ·`

| Font | Kết quả |
|---|---|
| **Be Vietnam Pro** | **16/16 `own`** — phủ hoàn toàn |
| **IBM Plex Mono** | **16/16 `own`** — phủ hoàn toàn |
| **Archivo** | **15/16 `own`** — ⚠ thiếu **`·` (U+00B7 MIDDLE DOT)**, phải fallback |

Đây là phát hiện mà `fonts.check()` **không** bắt được. Xem ràng buộc C2 ở §4.

### 3.3 Va chạm dấu — đo khoảng cách giữa hai line box

Đo trên Be Vietnam Pro 15px, dòng trên toàn chữ hoa có dấu (`ẲẴẶỠỢỮỰ`), dòng dưới có dấu móc dưới (`ựữứừụ ợỡởớờ ỵỹỷỳ`) — trường hợp xấu nhất của tiếng Việt.

| line-height | Khoảng cách giữa hai line box | Kết luận |
|---|---|---|
| 1.0 | **−4.00 px** | ❌ Va chạm nặng — thấy rõ trong ảnh, mục 6 |
| 1.1 | **−2.50 px** | ❌ Va chạm |
| 1.2 | **−1.00 px** | ❌ Va chạm |
| 1.25 | **−0.25 px** | ❌ Va chạm (sát ngưỡng) |
| **1.3** | **+0.50 px** | ✅ **Ngưỡng an toàn nhỏ nhất** |
| 1.35 | +1.25 px | ✅ |
| 1.4 | +2.00 px | ✅ |
| 1.5 | +3.50 px | ✅ |

Số âm nghĩa là hộp dòng chồng lên nhau — dấu thanh của dòng dưới có thể chạm dấu của dòng trên.

### 3.4 Kiểm chứng bằng mắt trên ảnh

| Hạng mục | Light | Dark | Ghi chú |
|---|---|---|---|
| Rõ ở 12px | ✅ | ✅ | Dấu thanh còn phân biệt được ở cả ba font |
| Rõ ở 14, 16, 24, 32px | ✅ | ✅ | — |
| Chữ hoa có dấu (`SỔ ĐIỀU HÀNH`, `TỐI ƯU CHUYỂN ĐỔI`) | ✅ | ✅ | Dấu không bị cắt trên |
| Tiền tệ `₫` | ✅ | ✅ | Render đúng ở cả ba font |
| Số tabular trong bảng | ✅ | ✅ | Cột `45.000.000 ₫` / `12,5%` thẳng hàng |
| State Ribbon + label Archivo | ✅ | ✅ | Notch thổ hoàng nổi rõ trên cả hai nền |
| Fallback (mục 8) | ✅ | ✅ | Dòng serif khác biệt rõ ⇒ chứng minh mục 1–7 **đã** dùng đúng font |
| Va chạm dấu ở line-height 1.0 (mục 6) | ❌ thấy rõ | ❌ thấy rõ | Xuất hiện ở cả hai theme ⇒ là vấn đề **metric**, không phải artifact render |

## 4. Ràng buộc thiết kế bắt buộc phát sinh

Hai ràng buộc dưới đây là **kết quả đo**, không phải sở thích. Chúng phải vào design token và phải có test.

### C1 — `line-height` tối thiểu cho mọi text tiếng Việt: **1.3**

**Blueprint rev 2 §9 ghi `line-height 1.25 cho heading` — giá trị này KHÔNG an toàn** (đo được −0.25px). Phải sửa.

Giá trị chốt:

| Vai trò | line-height | Lý do |
|---|---|---|
| Body | **1.5** | Giữ nguyên, dư biên an toàn |
| Heading | **1.3** (sửa từ 1.25) | Ngưỡng an toàn nhỏ nhất đo được |
| Dòng bảng | **1.4** | Giữ nguyên |
| Nhãn/eyebrow một dòng | **1.3** | Đồng nhất với heading |

Token `--lh-min: 1.3` là sàn tuyệt đối. Không component nào được đặt thấp hơn.

### C2 — Không dùng `·` (U+00B7) trong text render bằng Archivo

Archivo không có glyph này (§3.2). Trong ảnh nó vẫn hiện vì trình duyệt fallback, nhưng đó là glyph của font khác — chiều rộng và trọng lượng nét sẽ lệch khỏi phần còn lại của nhãn.

Lựa chọn thay thế cho separator trong nhãn Archivo: dùng khoảng trắng + border CSS, hoặc `—` (U+2014, Archivo có), hoặc chuyển separator sang Be Vietnam Pro. **Be Vietnam Pro và IBM Plex Mono có `·`** nên ràng buộc này chỉ áp cho Archivo.

## 5. Điều chưa kiểm tra

Ghi rõ để không tạo ảo giác về độ phủ của bài kiểm tra này:

| Chưa kiểm | Vì sao | Khi nào cần |
|---|---|---|
| Firefox, Safari, Edge | Chỉ chạy Chromium | Trước khi công bố cho người dùng ngoài |
| macOS, Linux, Android, iOS | Chỉ chạy Windows | Khi có người dùng trên nền tảng đó |
| Self-host font (`.woff2`) thay vì Google Fonts CDN | Harness dùng CDN | **M0** — quyết định self-host hay CDN là việc riêng, ảnh hưởng privacy và hiệu năng |
| Subsetting và kích thước file thực tế | Ngoài phạm vi V6 | M0 |
| Biến thể width của Archivo (`font-stretch`) ở mọi giá trị | Chỉ dùng 87.5% trong harness | Khi thiết kế component dùng trục width |
| Đo `font-display` và CLS khi font tải chậm | Ngoài phạm vi V6 | M0/M1 |

## 6. Tái lập

```powershell
# 1. Phục vụ harness (Node built-in, không cần cài gì)
node docs/research/assets/serve-harness.mjs   # hoặc bất kỳ static server nào

# 2. Mở http://127.0.0.1:8791/ trong Chromium trên Windows
# 3. Mục 9 tự chạy và in bảng kết quả
# 4. Thêm class "dark" vào <body> để kiểm tra dark mode
```

Harness không cần mạng ngoại trừ lần tải font từ Google Fonts.

---

**Kết luận cuối**: V6 chuyển sang `VERIFIED`. Ba font được chốt cho design system, kèm ràng buộc **C1 (`line-height` ≥ 1.3)** và **C2 (không dùng `·` trong Archivo)**.
