# ADR-008 — Typography và design token

- **Trạng thái**: ACCEPTED
- **Ngày**: 2026-08-11
- **Gate**: V6 — `docs/research/font-render-verification.md`
- **Nguồn**: Blueprint rev 2 §9, Direction 1 "Sổ điều hành"

## Bối cảnh

Design direction đã duyệt là "Sổ điều hành": nền giấy trung tính lạnh, accent chàm, hue "đang chờ bạn" là thổ hoàng, signature là State Ribbon. Blueprint đề xuất ba font nhưng đánh dấu `[NOT VERIFIED]` cho khả năng hiển thị tiếng Việt và chặn việc chốt tại V6.

V6 đã chạy: render thật trên Chromium/Windows, 44 font face, screenshot light và dark, đo per-glyph coverage và đo va chạm dấu.

## Quyết định

### Font — giữ nguyên cả ba, đã xác minh

| Vai trò | Font | License | Kết quả V6 |
|---|---|---|---|
| Nhãn bảng, eyebrow, section header | **Archivo** | SIL OFL | ✅ phủ đủ dấu thanh · ⚠ thiếu `·` |
| UI và body | **Be Vietnam Pro** | SIL OFL | ✅ phủ hoàn toàn 16/16 ký tự rủi ro |
| Số, ID, mã | **IBM Plex Mono** | SIL OFL | ✅ phủ hoàn toàn 16/16 |

### C1 — `line-height` tối thiểu 1.3 cho mọi text

**Sửa lỗi trong blueprint rev 2 §9**, vốn ghi `1.25 cho heading`. Đo được ở 15px Be Vietnam Pro, dòng trên toàn chữ hoa có dấu và dòng dưới có dấu móc:

| line-height | Khoảng cách line box | |
|---|---|---|
| 1.0 | −4.00 px | ❌ |
| 1.2 | −1.00 px | ❌ |
| 1.25 | −0.25 px | ❌ |
| **1.3** | **+0.50 px** | ✅ ngưỡng nhỏ nhất |
| 1.4 | +2.00 px | ✅ |
| 1.5 | +3.50 px | ✅ |

Token chốt:

```
--lh-min:    1.3   /* sàn tuyệt đối, không component nào được thấp hơn */
--lh-heading:1.3   /* sửa từ 1.25 */
--lh-table:  1.4
--lh-body:   1.5
```

### C2 — Không dùng `·` (U+00B7) trong text render bằng Archivo

Archivo không có glyph này; trình duyệt fallback sang font khác, làm lệch chiều rộng và trọng lượng nét trong nhãn. Thay bằng `—` (U+2014, Archivo có), hoặc separator bằng CSS border, hoặc đặt separator trong Be Vietnam Pro.

Ràng buộc chỉ áp cho Archivo — Be Vietnam Pro và IBM Plex Mono đều có `·`.

### Type scale

`0.6875 · 0.75 · 0.8125 · 0.875 · 1 · 1.125 · 1.375 · 1.75 · 2.25` rem, base 16px.

### Màu

```
Light                          Dark
--paper   #FBFBFA              #101216
--surface #FFFFFF              #181B21
--ink     #16181C              #F2F4F7
--ink-2   #4A505C              #A6AEBC
--rule    #E3E5E9              #262A32
--cham    #29406B  (accent)    #7C9BD1
--tho     #A9701A  (chờ bạn)   #D9A047
--moss    #2F6B4F  (success)   #5FA37E
--brick   #9B3226  (danger)    #D6705F
--slate   #445A78  (info)      (điều chỉnh khi dùng)
```

Dark mode **không đảo màu máy móc** — chàm và thổ hoàng sáng lên để giữ contrast ≥ 4.5:1 trên nền tối.

### Spacing và hình học

Đơn vị 4px: `4 8 12 16 24 32 48 64`. Grid 12 cột, gutter 16px. Left rail 224px (thu gọn 56px). Command bar 48px. Content max-width 1440px. Inspector 400px (đẩy nội dung). Approval drawer 560px (phủ, có backdrop). Border-radius tối đa 6px; bảng và hàng dùng 0px.

## Lý do

- Be Vietnam Pro được thiết kế cho tiếng Việt và đạt 16/16 ký tự rủi ro — đúng lựa chọn cho A3/A4.
- Archivo có trục width, cho phép nhãn condensed kiểu bảng thông tin mà không cần font thứ tư.
- IBM Plex Mono có tabular figure, cần cho việc so sánh số theo cột trong bảng.
- C1 và C2 là **kết quả đo**, không phải sở thích. Chúng phải có test.

## Hệ quả

- Font **chưa** được thêm vào ứng dụng. Quyết định self-host `.woff2` hay dùng CDN là việc của M0, ảnh hưởng privacy và hiệu năng.
- CI cần một test chặn `line-height` dưới 1.3 trong design token.
- Visual QA ở M1 phải kiểm lại C1 và C2 trên UI thật, không chỉ trên harness.

## Điều chưa kiểm — ghi rõ để không tạo ảo giác

Firefox/Safari/Edge · macOS/Linux/mobile · self-host và subsetting · kích thước file thực tế · `font-display` và CLS · mọi giá trị của trục width Archivo. Xem §5 của báo cáo V6.
