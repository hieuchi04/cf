# HNT Mail - Temp Mail trên Cloudflare

Hệ thống nhận email gửi tới `@hntdev.me`, lưu nội dung trong Cloudflare KV và cung cấp dashboard quản lý cùng REST API.

Địa chỉ ngẫu nhiên có dạng:

```text
oliverstone0427@hntdev.me
alicecarter9184@hntdev.me
```

Bạn cũng có thể tự tạo địa chỉ như `hieu@hntdev.me` hoặc `project.demo@hntdev.me`.

## Kiến trúc

```text
Email gửi tới *@hntdev.me
        |
Cloudflare Email Routing
        |
Email Worker -> Cloudflare KV
        |
REST API -> Website quản lý / ứng dụng của bạn
```

## 1. Tạo KV Namespace

Chạy trong thư mục dự án:

```bash
cd worker
npx wrangler@latest kv namespace create EMAIL_STORE
```

Sao chép `id` nhận được vào `worker/wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "EMAIL_STORE"
id = "KV_NAMESPACE_ID_CUA_BAN"
```

## 2. Tạo secret quản trị

```bash
npx wrangler@latest secret put API_SECRET
```

Nhập một chuỗi bí mật dài và ngẫu nhiên. Secret này dùng để đăng nhập dashboard và tạo/thu hồi API key. Không đặt secret trực tiếp trong `wrangler.toml`.

Bạn có thể thêm một API key tĩnh dành cho code nếu cần:

```bash
npx wrangler@latest secret put CODING_API_KEY
```

Dashboard cũng có thể tạo API key động ở mục **API**, vì vậy `CODING_API_KEY` là tùy chọn.

## 3. Deploy Worker

```bash
cd worker
npx wrangler@latest deploy
```

Ghi lại URL dạng `https://email-inbox-worker.<subdomain>.workers.dev`.

## 4. Cấu hình nhận mail cho hntdev.me

Trong Cloudflare Dashboard:

1. Chọn domain `hntdev.me`.
2. Mở **Email > Email Routing** và bật Email Routing.
3. Tạo route catch-all cho mọi địa chỉ `*@hntdev.me`.
4. Chọn action **Send to a Worker**.
5. Chọn Worker `email-inbox-worker`.

Không cần tạo từng tài khoản email trong Cloudflare. Route catch-all chuyển mọi địa chỉ thuộc domain tới Worker; ứng dụng phân loại thư theo trường `To`.

## 5. Deploy website

```bash
npx wrangler@latest pages deploy website --project-name tempmailx
```

Mở URL Pages, nhập Worker URL và `API_SECRET` để kết nối. Cấu hình được lưu trong local storage của trình duyệt hiện tại.

## REST API

API chấp nhận một trong hai header:

```http
Authorization: Bearer YOUR_API_KEY
```

hoặc:

```http
X-API-Key: YOUR_API_KEY
```

Các endpoint chính:

| Method | Endpoint | Chức năng |
| --- | --- | --- |
| `GET` | `/domains` | Danh sách domain |
| `GET` | `/mailboxes` | Danh sách hộp thư đã lưu |
| `POST` | `/mailboxes` | Tạo hộp thư tùy ý hoặc ngẫu nhiên |
| `DELETE` | `/mailboxes/:address?deleteEmails=true` | Xóa hộp thư |
| `GET` | `/emails?address=...` | Lấy email của một hộp thư |
| `GET` | `/emails/:id` | Đọc nội dung email |
| `DELETE` | `/emails/:id` | Xóa một email |
| `DELETE` | `/emails?address=...` | Xóa toàn bộ email của địa chỉ |
| `POST` | `/api-keys` | Tạo API key, chỉ dành cho admin |
| `GET` | `/api-keys` | Liệt kê API key, chỉ dành cho admin |
| `DELETE` | `/api-keys/:id` | Thu hồi API key, chỉ dành cho admin |

Tạo địa chỉ ngẫu nhiên:

```bash
curl -X POST "https://YOUR_WORKER.workers.dev/mailboxes" \
  -H "X-API-Key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"domain":"hntdev.me"}'
```

Tạo địa chỉ theo ý muốn:

```bash
curl -X POST "https://YOUR_WORKER.workers.dev/mailboxes" \
  -H "X-API-Key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"local":"hieu","domain":"hntdev.me"}'
```

Lấy inbox:

```bash
curl "https://YOUR_WORKER.workers.dev/emails?address=hieu@hntdev.me" \
  -H "X-API-Key: YOUR_API_KEY"
```

## Lưu ý bảo mật

- Chỉ dùng `API_SECRET` trên dashboard quản trị, không nhúng vào source code public.
- Dùng API key riêng cho từng ứng dụng và thu hồi key khi không còn sử dụng.
- Dashboard hiện là công cụ cá nhân có xác thực, chưa phải dịch vụ tempmail công cộng cho người dùng ẩn danh.
