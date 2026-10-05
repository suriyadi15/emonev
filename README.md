# eMonev Bulk Kehadiran

Userscript yang menambah panel **Bulk Kehadiran** di dua halaman eMonev, supaya kehadiran banyak orang bisa dikirim sekaligus:
- `https://emonev.una.ac.id/gjm/kehadiran_pegawai.php`: Kehadiran Pegawai/Staf
- `https://emonev.una.ac.id/gjm/kehadiran_struktural.php`: Kehadiran Struktural

## Install
1. Pasang ekstensi **Tampermonkey** atau **Violentmonkey** di browser.
2. Buat script baru, lalu tempel isi `emonev-bulk-kehadiran.user.js` dan simpan.
3. Login ke eMonev seperti biasa, lalu buka halaman Kehadiran Pegawai atau Kehadiran Struktural. Tombol **Bulk Kehadiran** muncul di kanan bawah.

## Pemakaian (Kehadiran Pegawai/Staf)
- **Tab Pegawai**: tambah pegawai (nama + unit), atau tempel banyak sekaligus dengan format `nama;unit` per baris.
  Data disimpan di localStorage browser. Gunakan **Export JSON** untuk backup dan **Import JSON** untuk memindahkan ke browser lain.
- **Tab Submit**:
  - Isi **Tanggal**. Satu tanggal ini dipakai untuk semua pegawai.
  - **Centang** pegawai yang mau dikirim. Semua yang dicentang ikut dikirim, apa pun statusnya.
  - Status awal `hadir`. Bisa diubah per baris, atau semuanya sekaligus lewat **Ubah semua status → Terapkan**.
    Pilihan statusnya: `hadir`, `terlambat`, `izin`, `tidak_hadir`. Kolom menit telat hanya aktif untuk status `terlambat`.
  - **Dry run** (aktif secara default) hanya menampilkan data yang akan dikirim, tanpa mengirim apa pun.
    Matikan Dry run, lalu klik **Kirim** untuk benar-benar mengirim.
  - Data dikirim satu per satu dengan jeda sekitar 0,7 detik. Pengiriman bisa dihentikan dengan **Stop**.
    Pegawai yang gagal bisa dikirim ulang dengan **Ulangi yang gagal**.
  - Kalau session habis, pengiriman berhenti. Login ulang, buka halaman ini lagi, lalu kirim sisanya.
- **Tab Log**: riwayat pengiriman (maksimal 500 entri). Muncul peringatan kalau pegawai yang sama sudah pernah sukses dikirim untuk tanggal yang sama.

## Pemakaian (Kehadiran Struktural)
- Tidak perlu mengisi daftar sendiri. Daftar jabatan (Dekan, Wakil Dekan, Kaprodi, dan lain-lain) diambil langsung dari pilihan
  **Pejabat/Struktural** di halaman, lalu dikirim sebagai `struktural_id`. Karena itu tab Pegawai tidak muncul di halaman ini.
- Pilihan status juga diambil dari form di halaman: `hadir`, `terlambat`, `tidak_hadir` (tanpa `izin`).
- Cara pakai lainnya sama: satu tanggal untuk semua, centang yang akan dikirim, Dry run, lalu Kirim.
  Centang di halaman ini disimpan terpisah dari centang di halaman pegawai.

## Uji pertama di web asli
1. Kirim dengan **Dry run aktif**. Pastikan token csrf terbaca dan datanya benar.
2. Matikan Dry run, kirim **1 pegawai** saja, lalu cek di web bahwa datanya masuk dan hasilnya ✓.
3. Setelah itu baru kirim sekaligus.

> Sukses atau gagal ditebak dari pesan alert di halaman balasan server. Kalau tanda ✓/✗ tidak cocok
> dengan kenyataan di web, kirim contoh HTML balasannya supaya deteksinya bisa disesuaikan.
