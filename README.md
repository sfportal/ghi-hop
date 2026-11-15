# Ghi Họp: ghi âm, chép lời trực tiếp, ghi chú và tóm tắt cuộc họp

Bản demo 0.1 · 15/11/2026 · Yu

## Bản demo làm được gì
- **Ghi âm** cuộc họp ngay trên trình duyệt (máy tính và điện thoại), lưu file ghi âm để nghe lại hoặc tải về.
- **Chép lời tiếng Việt trực tiếp**: lời nói hiện ra từng câu kèm mốc giờ [mm:ss]. Sửa được chữ sai ngay trên bản chép lời.
- **Ghi chú trong lúc họp**, tự gắn mốc giờ, chia loại: Ghi chú, Quan trọng, Quyết định, Việc cần làm, Câu hỏi.
- **Nút “⭐ Đánh dấu đoạn vừa nói”** (phím tắt Ctrl+B): lấy khoảng 20 giây vừa nói thành một ý Quan trọng, tô vàng trên bản chép lời.
- **Tổng hợp đến lúc này** (bấm tay hoặc tự động mỗi 3, 5, 10 phút): các ý đang bàn, quyết định, việc cần làm.
- **Tóm tắt cuộc họp** sau khi kết thúc: biên bản gồm tóm tắt nhanh, nội dung chính, quyết định, bảng việc cần làm (ai, hạn, mốc giờ), các ý bạn đánh dấu, vấn đề còn mở. Mọi ghi chú Quan trọng, Quyết định, Việc cần làm đều được đưa vào.
- Bấm mốc giờ để nghe lại đúng đoạn đó. Sao chép hoặc tải biên bản .md (kèm ghi chú và bản chép lời).
- **Cài như ứng dụng** (PWA): trên Chrome/Edge máy tính bấm “Cài ứng dụng”; trên iPhone mở bằng Safari, Chia sẻ, “Thêm vào MH chính”; trên Android, menu Chrome, “Cài đặt ứng dụng”.
- Dữ liệu cuộc họp lưu ngay trên máy (IndexedDB), chưa đưa lên máy chủ.

## Kiến trúc

| Phần | Bản demo (hiện tại) | Bản chính thức (đề xuất) |
|---|---|---|
| Giao diện | PWA thuần HTML/JS, không cần build | Giữ nguyên, thêm đăng nhập |
| Chép lời real-time | Web Speech API của trình duyệt, `vi-VN`, miễn phí | Dịch vụ chép lời qua máy chủ (Soniox, Google Chirp, Azure Speech…), chính xác hơn, có tách người nói, chạy được trên mọi trình duyệt |
| Tóm tắt | Claude Opus 5.5 (`claude-opus-5-5`), adaptive thinking, streaming, có model dự phòng khi bị từ chối | Như bản demo, gọi qua Worker |
| Khóa Claude | Chế độ demo: người dùng dán khóa, lưu trong trình duyệt. Chế độ máy chủ: khóa nằm ở Cloudflare | Chỉ chế độ máy chủ |
| Lưu trữ | IndexedDB trên máy | Supabase (Postgres + Storage cho file ghi âm, Auth) để đồng bộ nhiều máy, chia sẻ biên bản |
| Host | Cloudflare Workers (static assets + `/api/summarize`) | Như vậy, tên miền riêng |

Chi phí Claude ước tính: một cuộc họp 1 giờ khoảng 20.000 đến 30.000 token đầu vào, 2.000 đến 4.000 token đầu ra, tức khoảng 0,15 đến 0,2 USD mỗi lần tóm tắt với Opus 5.5 (4 USD/20 USD mỗi triệu token). Mỗi lần “Tổng hợp đến lúc này” rẻ hơn nhiều.

## Giới hạn của chép lời bằng trình duyệt (bản demo)
- Chạy tốt trên **Chrome, Edge** (máy tính, Android) và **Safari** (iPhone, Mac). **Firefox không hỗ trợ.**
- Cần mạng (Chrome gửi âm thanh tới dịch vụ nhận dạng của Google).
- Không tách được ai nói. Độ chính xác giảm khi phòng ồn, nhiều người nói chồng.
- Trên một số máy Android, chép lời và ghi âm cùng lúc tranh nhau micro: nếu không thấy chữ hiện ra, vào Cài đặt tắt “Lưu file ghi âm”.
- Giữ màn hình mở trong khi họp (ứng dụng tự xin giữ màn hình sáng).

## Cách chạy

### Cách 1, nhanh nhất (chế độ demo, khóa Claude trên máy)
1. Cloudflare Dashboard, Workers & Pages, Create, Pages, **Upload assets**, kéo thả thư mục `public/`.
2. Mở đường dẫn https được cấp, vào ⚙︎ Cài đặt, dán khóa Claude API (console.anthropic.com).
Chỉ dùng cách này cho bản thân, vì khóa nằm trong trình duyệt.

### Cách 2, chế độ máy chủ (khóa nằm trên Cloudflare)
```bash
npm install
npx wrangler login
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put APP_PASSCODE   # tùy chọn: mã truy cập để người lạ không dùng ké
npx wrangler deploy
```
Ứng dụng tự nhận ra có máy chủ (`/api/health`) và không hỏi khóa nữa.

Chạy thử trên máy: `npx wrangler dev`, mở http://localhost:8787 (micro chỉ chạy trên https hoặc localhost).

## Cấu trúc thư mục
```
public/            giao diện PWA (index.html, app.js, style.css, sw.js, manifest, icons)
public/prompts.js  câu lệnh cho Claude + hàm gọi tóm tắt, dùng chung cho trình duyệt và Worker
public/vendor/     Anthropic SDK đóng gói sẵn cho trình duyệt (chế độ demo)
worker/index.js    Cloudflare Worker: /api/health, /api/summarize, phục vụ file tĩnh
wrangler.toml      cấu hình Cloudflare
```

## Việc tiếp theo (chờ chốt)
1. Chép lời bằng dịch vụ chuyên dụng qua máy chủ, có tách người nói.
2. Đăng nhập, đồng bộ Supabase, chia sẻ biên bản bằng đường dẫn.
3. Nhập file ghi âm có sẵn (.m4a, .mp3) để chép lời và tóm tắt sau.
4. Mẫu biên bản theo đơn vị (BVI, DaLa, Salefronts, An Nông), xuất Word/PDF, gửi Zalo/email.
