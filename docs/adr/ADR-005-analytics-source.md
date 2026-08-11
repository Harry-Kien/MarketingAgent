# ADR-005 — Nguồn analytics

- **Trạng thái**: ACCEPTED cho hướng đi · **PENDING** phần thực thi cho tới khi V2/V3 xong
- **Ngày**: 2026-08-11
- **Nguồn**: Blueprint rev 2 §4.3, §5 #11, R6

## Bối cảnh

PostHog cung cấp 14 sản phẩm gồm Product Analytics, Funnels, Session Replay, CDP, Data Warehouse và Experiments — license MIT cho core (`ee/` riêng). Tự xây analytics engine là chi phí cơ hội quá lớn cho một người.

## Quyết định

1. **Không tự xây analytics engine.** Tích hợp PostHog làm nguồn event, funnel và experiment.
2. **Tự xây phần marketing-specific** mà PostHog không có: attribution model, CAC, LTV, ROAS, pipeline quy thuộc.
3. **Slice 1 không tích hợp PostHog.** Slice 1 dùng event ingestion qua signed webhook của chính ta và **một** report duy nhất. PostHog vào ở M5.

## Lý do

- Ranh giới rõ: PostHog trả lời *"người dùng làm gì"*; ta trả lời *"marketing tạo ra bao nhiêu giá trị"*. Không chồng lấn.
- License MIT core có exit path (self-host), thoả A6.
- Hoãn tới M5 giữ Slice 1 mỏng và cho phép hoàn tất V2/V3 trước.

## Ràng buộc bắt buộc khi hiển thị số

Mọi `Metric` render ra UI **phải** có: `freshness_at`, `attribution_model`, `attribution_window`, `confidence`, `missing_data_note`. Thiếu bất kỳ trường nào thì **không được render số**. Đây là bất biến, cưỡng chế ở tầng component.

## Điểm chưa xác minh — chặn M5

| Gate | Nội dung |
|---|---|
| **V2** | GA4 Data API quota trên trang Google chính thức. Hiện chỉ có nguồn thứ cấp: 1 250 token/giờ, 25 000 token/ngày, 10 concurrent |
| **V3** | Google Search Console API quota — chưa tìm được tài liệu |

Vì quota GA4 hẹp, **PostHog là nguồn chính**, GA4/GSC là nguồn bổ sung đọc theo batch có cache.
