# ADR-004 — Model Gateway

- **Trạng thái**: ACCEPTED
- **Ngày**: 2026-08-11
- **Nguồn**: Blueprint rev 2 §5 #8, R1

## Bối cảnh

Chi phí LLM là biến số chi phối ngân sách (R1), không phải hạ tầng. Blueprint yêu cầu provider-agnostic (A6), per-run cost/time budget, prompt/model versioning, và **fake provider tất định cho test**.

## Quyết định

**`packages/model-gateway` tự xây, bọc `ai@7` (Vercel AI SDK, Apache-2.0).**

Không gọi SDK của provider trực tiếp từ agent code. Mọi lời gọi model đi qua gateway.

## Lý do

1. **`ai@7` là provider-agnostic và TypeScript-native**, thoả A6 và A9. LiteLLM mạnh hơn về routing nhưng là Python — vi phạm A9.
2. **Lớp bọc của ta là nơi cưỡng chế**: per-run budget, per-day budget, kill switch, cost tracking, prompt version, model version, redaction PII trước khi gửi. Những thứ này là yêu cầu domain, không phải tính năng của SDK.
3. **Fake provider tất định** là điều kiện để TDD agent runtime mà không tốn tiền và không phụ thuộc mạng. Gateway là chỗ duy nhất cần cắm fake.

## Hệ quả

- Agent code phụ thuộc **interface của gateway**, không phụ thuộc `ai` SDK. Đổi SDK là đổi một tầng.
- Test chạy với fake provider — **không lời gọi tính phí nào trong CI** (bất biến của M0/M1).
- Gateway ghi `cost_usd`, `token_in`, `token_out`, `wallclock_ms`, `prompt_version`, `model_version` vào `AgentRun`.
- Vượt budget ⇒ dừng cứng, không degrade âm thầm.
- Trace xuất sang Langfuse và OpenTelemetry ở tầng gateway, không rải rác trong agent code.
- **Model tiering** (model rẻ cho phân loại, model mạnh cho viết) cấu hình ở gateway, không hard-code trong agent.
