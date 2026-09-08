# Hướng dẫn triển khai HNT Mail bằng Cloudflare Dashboard

Tài liệu này hướng dẫn triển khai toàn bộ dự án bằng giao diện web của Cloudflare, không cần Wrangler hoặc terminal.

## Kết quả sau khi hoàn thành

- Worker nhận email gửi đến `*@hntdev.me`.
- Email được lưu trong Cloudflare KV.
- Website quản lý được triển khai trên Cloudflare Pages.
- Có thể tạo địa chỉ tùy ý hoặc ngẫu nhiên dạng `firstName + lastName + 4 số`.
- Có thể tạo API key riêng để sử dụng trong code.

## Thành phần của dự án

```text
email-inbox-multidomain/
├── worker/
│   └── email-worker.js
└── website/
    └── index.html
```

Khi triển khai bằng Dashboard, file `worker/wrangler.toml` không được sử dụng. KV binding, variable và secret sẽ được cấu hình trực tiếp trong phần Settings của Worker.

---

## 1. Thêm hntdev.me vào Cloudflare

Cloudflare Email Routing yêu cầu domain sử dụng Cloudflare DNS.

1. Đăng nhập [Cloudflare Dashboard](https://dash.cloudflare.com/).
2. Mở **Domains**.
3. Chọn **Onboard a domain** hoặc **Add a domain**.
4. Nhập `hntdev.me`.
5. Chọn gói Cloudflare phù hợp; gói Free đủ cho dự án này.
6. Chờ Cloudflare quét các DNS record hiện tại.

### Kiểm tra DNS trước khi tiếp tục

Website hiện tại của `hntdev.me` đang sử dụng các địa chỉ sau. Đảm bảo chúng xuất hiện trong **DNS > Records** của Cloudflare:

| Type | Name | Content |
| --- | --- | --- |
| `A` | `@` | `185.199.108.153` |
| `A` | `@` | `185.199.109.153` |
| `A` | `@` | `185.199.110.153` |
| `A` | `@` | `185.199.111.153` |

Kiểm tra và sao chép thêm mọi record `CNAME`, `TXT` hoặc record xác minh dịch vụ đang sử dụng. Việc thiếu record có thể khiến website hoặc dịch vụ hiện tại ngừng hoạt động sau khi đổi nameserver.

## 2. Đổi nameserver tại nhà cung cấp domain

Cloudflare sẽ hiển thị hai nameserver riêng, ví dụ:

```text
example-one.ns.cloudflare.com
example-two.ns.cloudflare.com
```

Nameserver hiện tại của `hntdev.me` là:

```text
dns1.registrar-servers.com
dns2.registrar-servers.com
```

Thực hiện tại website nơi bạn mua domain:

1. Mở trang quản lý `hntdev.me`.
2. Tìm phần **Nameservers**.
3. Chọn **Custom DNS** hoặc **Custom nameservers**.
4. Xóa hai nameserver cũ.
5. Nhập chính xác hai nameserver Cloudflare cấp.
6. Lưu thay đổi.

Nếu DNSSEC đang bật tại nhà cung cấp cũ, hãy tắt DNSSEC trước khi đổi nameserver. Sau khi Cloudflare báo domain `Active`, có thể bật lại DNSSEC trong Cloudflare.

Không cần chuyển quyền đăng ký domain sang Cloudflare Registrar.

Quá trình cập nhật thường mất từ vài phút đến vài giờ. Chỉ tiếp tục cấu hình Email Routing sau khi Cloudflare hiển thị domain ở trạng thái **Active**.

---

## 3. Tạo KV Namespace

1. Trong Cloudflare Dashboard, mở **Storage & Databases**.
2. Chọn **KV**.
3. Nhấn **Create namespace**.
4. Đặt tên:

```text
email-inbox-store
```

5. Nhấn **Create**.

Tên namespace có thể thay đổi. Ở bước gắn binding, variable name bắt buộc phải là `EMAIL_STORE`.

---

## 4. Tạo Email Worker

1. Mở **Compute & AI > Workers & Pages**.
2. Chọn **Create application**.
3. Chọn **Worker** hoặc **Start with Hello World**.
4. Đặt tên Worker:

```text
email-inbox-worker
```

5. Hoàn tất việc tạo Worker.
6. Mở Worker vừa tạo và chọn **Edit code**.
7. Xóa toàn bộ code mẫu.
8. Mở file `worker/email-worker.js` trên máy.
9. Sao chép toàn bộ nội dung file vào Cloudflare editor.
10. Nhấn **Deploy**.

Worker này có hai handler:

- `fetch()` cung cấp REST API cho website và ứng dụng.
- `email()` tiếp nhận email từ Email Routing.

## 5. Gắn KV binding

1. Mở Worker `email-inbox-worker`.
2. Chọn **Settings > Bindings**.
3. Chọn **Add binding**.
4. Chọn loại **KV Namespace**.
5. Nhập variable name:

```text
EMAIL_STORE
```

6. Chọn namespace `email-inbox-store` đã tạo.
7. Nhấn **Save and deploy**.

Tên `EMAIL_STORE` phân biệt chữ hoa và chữ thường, phải nhập đúng hoàn toàn.

## 6. Thêm domain variable

1. Trong Worker, mở **Settings > Variables and Secrets**.
2. Chọn **Add**.
3. Chọn loại variable dạng text/plaintext.
4. Nhập:

```text
Name: ALLOWED_DOMAINS
Value: hntdev.me
```

5. Lưu và deploy thay đổi.

Nếu sau này sử dụng nhiều domain, phân cách bằng dấu phẩy:

```text
hntdev.me,example.com
```

## 7. Tạo API_SECRET

`API_SECRET` là mật khẩu quản trị dùng để đăng nhập website và quản lý API key.

1. Trong **Settings > Variables and Secrets**, chọn **Add**.
2. Chọn loại **Secret**.
3. Nhập tên:

```text
API_SECRET
```

4. Dùng password manager để tạo một chuỗi ngẫu nhiên dài ít nhất 32 ký tự.
5. Nhập chuỗi đó làm giá trị secret.
6. Lưu chuỗi vào password manager.
7. Nhấn **Deploy**.

Không đặt `API_SECRET` trong source code, `wrangler.toml`, GitHub hoặc Pages environment variables.

## 8. Kiểm tra Worker URL

Mở Worker và sao chép URL dạng:

```text
https://email-inbox-worker.<workers-subdomain>.workers.dev
```

Mở URL đó trực tiếp có thể nhận được:

```json
{"error":"Unauthorized"}
```

Đây là kết quả đúng vì API yêu cầu xác thực.

---

## 9. Kích hoạt Email Routing

Chỉ thực hiện bước này khi `hntdev.me` đã có trạng thái **Active** trên Cloudflare.

1. Mở **Compute > Email Service > Email Routing**.
2. Chọn `hntdev.me`.
3. Chọn **Onboard Domain**.
4. Xem các DNS record Cloudflare chuẩn bị thêm.
5. Xác nhận để Cloudflare thêm MX, SPF và các record cần thiết.
6. Chờ trạng thái cấu hình chuyển sang `Ready` hoặc `Enabled`.

### Cảnh báo về email forwarding hiện tại

`hntdev.me` hiện đang sử dụng MX của `registrar-servers.com`. Khi kích hoạt Cloudflare Email Routing, hệ thống chuyển tiếp email cũ sẽ ngừng nhận mail.

Nếu đang có các địa chỉ quan trọng, hãy tạo rule riêng trong Cloudflare trước hoặc cùng lúc với catch-all, ví dụ:

```text
admin@hntdev.me   -> Forward to địa chỉ email cá nhân
contact@hntdev.me -> Forward to địa chỉ email cá nhân
Catch-all         -> Send to email-inbox-worker
```

Các destination email dùng để forward phải được xác minh theo email Cloudflare gửi.

## 10. Tạo Catch-all rule

1. Trong **Email Routing**, mở **Routing Rules**.
2. Tìm **Catch-all rule**.
3. Chuyển trạng thái thành **Active**.
4. Chọn action **Send to a Worker**.
5. Chọn Worker:

```text
email-inbox-worker
```

6. Nhấn **Save**.

Không cần tạo từng địa chỉ email trong Cloudflare. Catch-all chuyển mọi email gửi tới `*@hntdev.me` vào Worker; Worker phân loại thư dựa trên địa chỉ người nhận.

---

## 11. Deploy website bằng Pages Direct Upload

1. Mở **Compute & AI > Workers & Pages**.
2. Chọn **Create application**.
3. Chọn tab **Pages**.
4. Chọn **Use direct upload** hoặc **Upload assets**.
5. Đặt project name:

```text
tempmailx
```

6. Upload thư mục `website`.
7. Nhấn **Deploy site**.

Nội dung upload phải có `index.html` ngay tại thư mục gốc:

```text
upload-root/
└── index.html
```

Không upload toàn bộ repository làm website. Nếu upload ZIP, mở ZIP và kiểm tra `index.html` không nằm trong một thư mục lồng như `website/index.html`.

Sau khi deploy, Cloudflare cung cấp URL dạng:

```text
https://tempmailx.pages.dev
```

## 12. Kết nối website với Worker

1. Mở URL Pages vừa nhận.
2. Nhập Worker URL ở bước 8.
3. Nhập `API_SECRET` ở bước 7.
4. Nhấn **Kết nối**.

Website lưu cấu hình kết nối trong local storage của trình duyệt. Chỉ đăng nhập bằng `API_SECRET` trên thiết bị và trình duyệt bạn tin cậy.

---

## 13. Kiểm tra nhận email

1. Trên website, nhấn **Tạo ngẫu nhiên**.
2. Hệ thống tạo địa chỉ tương tự:

```text
oliverstone0427@hntdev.me
```

3. Sao chép địa chỉ.
4. Dùng Gmail hoặc dịch vụ khác gửi một email thử đến địa chỉ này.
5. Chờ khoảng một phút.
6. Nhấn **Làm mới** hoặc chờ chế độ tự động làm mới.
7. Chọn email trong danh sách để xem nội dung.

Nếu email không xuất hiện, mở **Email Routing > Activity Log** để kiểm tra email có đến Cloudflare và được chuyển tới Worker hay không.

## 14. Tạo API key dành cho code

1. Đăng nhập website bằng `API_SECRET`.
2. Mở mục **API** trên thanh điều hướng.
3. Nhập tên key, ví dụ `VS Code` hoặc `My App`.
4. Nhấn **Tạo key**.
5. Sao chép key dạng:

```text
tm_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Key chỉ hiển thị một lần. Mỗi ứng dụng nên dùng một key riêng để có thể thu hồi độc lập.

Ví dụ gọi API:

```bash
curl -X POST "https://YOUR_WORKER.workers.dev/mailboxes" \
  -H "X-API-Key: tm_live_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"domain":"hntdev.me"}'
```

## 15. Gắn custom domain cho website

Đây là bước tùy chọn.

1. Mở Pages project `tempmailx`.
2. Chọn **Custom domains**.
3. Chọn **Set up a custom domain**.
4. Nhập, ví dụ:

```text
mail.hntdev.me
```

5. Xác nhận để Cloudflare tạo DNS record.

Custom domain của website không ảnh hưởng tới việc nhận email tại `@hntdev.me`.

---

## Khắc phục lỗi thường gặp

### Website báo Unauthorized

- Kiểm tra Worker URL không có dấu `/` thừa ở cuối.
- Kiểm tra `API_SECRET` nhập trên website giống secret đã cấu hình.
- Đảm bảo secret được thêm vào đúng Worker `email-inbox-worker`.

### Worker báo lỗi EMAIL_STORE

- Mở **Worker > Settings > Bindings**.
- Kiểm tra KV binding có variable name chính xác là `EMAIL_STORE`.
- Deploy lại Worker sau khi thêm binding.

### Domain không xuất hiện

- Kiểm tra `ALLOWED_DOMAINS` là variable dạng text.
- Giá trị phải là `hntdev.me`, không bao gồm `@` hoặc `https://`.

### Email không tới Worker

- Domain phải ở trạng thái **Active** trên Cloudflare.
- Email Routing phải ở trạng thái `Enabled` hoặc `Ready`.
- Catch-all rule phải `Active` và trỏ đúng Worker.
- Kiểm tra MX record trong **DNS > Records** và Activity Log của Email Routing.

### Website cũ ngừng hoạt động sau khi đổi nameserver

- Kiểm tra bốn bản ghi A đã được thêm vào Cloudflare.
- Kiểm tra các CNAME như `www` và record xác minh GitHub Pages nếu đang sử dụng.

## Checklist hoàn tất

- [ ] `hntdev.me` đang `Active` trên Cloudflare.
- [ ] DNS website cũ đã được sao chép đầy đủ.
- [ ] KV namespace đã được tạo.
- [ ] Worker đã được deploy từ `worker/email-worker.js`.
- [ ] KV binding có tên `EMAIL_STORE`.
- [ ] Variable `ALLOWED_DOMAINS` có giá trị `hntdev.me`.
- [ ] Secret `API_SECRET` đã được tạo và lưu an toàn.
- [ ] Email Routing đã được onboard.
- [ ] Catch-all đang gửi email tới `email-inbox-worker`.
- [ ] Thư mục `website` đã được deploy lên Pages.
- [ ] Website kết nối thành công tới Worker.
- [ ] Email thử nghiệm đã xuất hiện trong inbox.

## Tài liệu Cloudflare

- [Onboard domain](https://developers.cloudflare.com/fundamentals/manage-domains/add-site/)
- [KV namespaces](https://developers.cloudflare.com/kv/concepts/kv-namespaces/)
- [Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Email Routing](https://developers.cloudflare.com/email-service/get-started/route-emails/)
- [Email Routing rules](https://developers.cloudflare.com/email-service/configuration/email-routing-addresses/)
- [Pages Direct Upload](https://developers.cloudflare.com/pages/get-started/direct-upload/)
