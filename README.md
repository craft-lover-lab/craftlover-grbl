# Laser Tool

Phần mềm điều khiển máy khắc/cắt laser chạy firmware GRBL 1.1, viết bằng Electron, TypeScript và React.
Mặc định được cấu hình cho Sculpfun S30 10W (bàn máy 410×400 mm, `$30=1000`, 115200 baud).

## Chạy chương trình

```powershell
npm install
npm start        # build và mở ứng dụng
npm run dev      # chế độ phát triển (tự tải lại giao diện)
```

## Tính năng (giai đoạn 1)

| Tính năng | Trạng thái |
|---|---|
| Kết nối GRBL qua cổng COM, xem trạng thái/vị trí, console gửi lệnh | ✅ |
| Jog X/Y, về gốc, Homing `$H`, mở khóa `$X`, bắn tia 1% để căn | ✅ |
| **Đặt gốc tọa độ** tại vị trí đầu laser (`G10 L20 P1 X0 Y0`) | ✅ |
| Chạy theo gốc làm việc **hoặc** từ vị trí đầu laser hiện tại với 9 điểm neo | ✅ |
| **Chạy khung** vùng cắt với công suất thấp (mặc định 1%, chỉnh 0–5%; đặt 0 để tắt tia) | ✅ |
| Nhập SVG (path, rect bo góc, circle, ellipse, line, polyline, polygon, transform, đơn vị mm/in/pt/px) | ✅ |
| Nhập ảnh JPG/PNG/BMP/GIF/WEBP để khắc: Floyd–Steinberg, ngưỡng đen trắng, thang xám | ✅ |
| Nhập PDF / AI (mỗi trang thành một ảnh 300 DPI để khắc) | ✅ |
| **Nhân bản** theo lưới cột × hàng để cắt nhiều sản phẩm trong một lần | ✅ |
| Lớp gia công: Cắt, Khắc nét, Khắc tô kín vector, Khắc ảnh (tốc độ, công suất, số lượt, quét 2 chiều, đi quá biên) | ✅ |
| Tối ưu thứ tự cắt: cắt chi tiết bên trong trước đường bao ngoài, chọn đường gần nhất | ✅ |
| Xem trước đường chạy và ước tính thời gian, lưu G-code ra file | ✅ |
| Tạm dừng, tiếp tục, DỪNG khẩn (reset mềm, tắt laser ngay) | ✅ |

## Giai đoạn 2

| Tính năng | Ghi chú |
|---|---|
| **PDF / AI dạng vector** để cắt | Đường trong file được giữ nguyên thành nét cắt. Nếu trang có chữ chưa chuyển thành đường cong hoặc có hình ảnh, phần mềm nhập thêm một bản ảnh để khắc. |
| **EPS** | Cần cài [Ghostscript](https://ghostscript.com/releases/gsdnld.html) bản 64-bit. Phần mềm tự tìm `gswin64c.exe` và chạy ở chế độ an toàn `-dSAFER`. |
| **Dò viền ảnh** thành đường cắt | Chọn ảnh, chỉnh ngưỡng và độ làm mượt, rồi bấm "✎ Dò viền". |
| **Xoay, lật** | Xoay 90° hoặc một góc bất kỳ, lật ngang, lật dọc. Áp dụng được cho cả vector lẫn ảnh. |
| **Chữ** | Dùng font đã cài trên Windows (có dấu tiếng Việt), chữ nhiều dòng, căn trái/giữa/phải. |
| **Lưu / mở dự án** `.lzr` | Lưu đối tượng (kèm ảnh) và các lớp gia công. |
| Nhân đôi, phím tắt | Ctrl+D nhân đôi, Delete xóa, phím mũi tên dịch 1 mm (giữ Shift: 10 mm). |

### Ý tưởng tiếp theo

- Mô phỏng từng bước theo thời gian.
- Tự tách lớp theo màu nét trong file SVG.
- Camera căn phôi.
- Khắc trên vật tròn (rotary).

## Thiết lập máy Sculpfun S30

Hãy kiểm tra các thông số này bằng lệnh `$$` trong console:

- `$32=1`: bật chế độ laser. Bắt buộc, để laser tắt khi chạy G0 và để M4 hoạt động.
- `$30=1000`: S max, phải khớp với ô "S max" trong phần Công việc.
- `$130` / `$131`: hành trình X/Y, khoảng 410/400.

## An toàn

Luôn đeo kính bảo hộ đúng bước sóng 450 nm và không để máy chạy khi không có người trông.
Nút **■ DỪNG** gửi lệnh reset mềm (Ctrl-X), laser tắt ngay lập tức.

## Kiểm thử tự động

Chạy lệnh dưới đây, ứng dụng sẽ nạp các file mẫu, chụp màn hình, xuất G-code rồi tự thoát:

```bash
LASER_SNAPSHOT=shot.png LASER_GCODE_OUT=job.gcode LASER_DEMO="samples/hop-qua.svg;samples/gradient.png" \n  LASER_ACTIONS='[["select",0],["rotate",90],["list"]]' npx electron .
```
