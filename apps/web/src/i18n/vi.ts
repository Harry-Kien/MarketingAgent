export const messages = {
  nav: { today: "Sổ điều hành", campaigns: "Chiến dịch", content: "Nội dung", approvals: "Phê duyệt", analytics: "Kết quả" },
  home: { title: "Sổ điều hành", briefTitle: "Tóm tắt hôm nay", needsYou: "Cần bạn xử lý", atRisk: "Chiến dịch có rủi ro" },
  approval: {
    pendingTitle: "Đang chờ bạn phê duyệt",
    pendingCount: "{count} mục đang chờ bạn",
    approve: "Phê duyệt", reject: "Từ chối", requestChanges: "Yêu cầu chỉnh sửa",
    evidence: "Bằng chứng và nguồn", targetChannel: "Kênh đích", estimatedImpact: "Tác động ước tính",
    missingEvidence: "Thiếu bằng chứng nên chưa thể phê duyệt",
    disconnected: "Kênh đích đang ngắt kết nối nên chưa thể phê duyệt",
  },
  campaign: { title: "Chiến dịch", lifecycle: "Vòng đời", budget: "Ngân sách", conversion: "Chuyển đổi" },
  content: { title: "Nội dung", version: "Phiên bản", publicationContent: "Nội dung sẽ đăng", citations: "Nguồn trích dẫn" },
  analytics: { title: "Kết quả", freshness: "Cập nhật lúc", attributionModel: "Mô hình quy thuộc", confidence: "Độ tin cậy", missingData: "Thiếu dữ liệu" },
  state: {
    loading: "Đang tải", empty: "Chưa có dữ liệu", error: "Không tải được dữ liệu",
    partial: "Dữ liệu chưa đầy đủ", stale: "Dữ liệu đã cũ",
    unauthorized: "Bạn không có quyền xem mục này", disconnected: "Kết nối đang gián đoạn",
    retry: "Thử lại",
  },
  lifecycle: {
    DRAFT: "Nháp", RESEARCHING: "Đang nghiên cứu", PLANNED: "Đã lên kế hoạch",
    IN_PROGRESS: "Đang thực hiện", INTERNAL_REVIEW: "Đang rà soát nội bộ",
    WAITING_APPROVAL: "Chờ duyệt", APPROVED: "Đã duyệt", SCHEDULED: "Đã lên lịch",
    EXECUTING: "Đang thực thi", MEASURING: "Đang đo lường", COMPLETED: "Hoàn tất",
    BLOCKED: "Bị chặn", FAILED_RETRYABLE: "Lỗi có thể thử lại",
    FAILED_TERMINAL: "Lỗi không thể tiếp tục", CANCELLED: "Đã huỷ",
  },
} as const;
