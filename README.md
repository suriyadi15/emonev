# eMonev Bulk Kehadiran Pegawai

Userscript yang menambah panel **Bulk Kehadiran** di halaman
`https://emonev.una.ac.id/gjm/kehadiran_pegawai.php`, supaya kehadiran banyak pegawai bisa dikirim sekaligus.

## Install
1. Pasang ekstensi **Tampermonkey** atau **Violentmonkey** di browser.
2. Buat script baru, lalu tempel isi `emonev-bulk-kehadiran.user.js` dan simpan.
3. Login ke eMonev seperti biasa, lalu buka halaman Kehadiran Pegawai. Tombol **Bulk Kehadiran** muncul di kanan bawah.

## Pemakaian
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

## Uji pertama di web asli
1. Kirim dengan **Dry run aktif**. Pastikan token csrf terbaca dan datanya benar.
2. Matikan Dry run, kirim **1 pegawai** saja, lalu cek di web bahwa datanya masuk dan hasilnya ✓.
3. Setelah itu baru kirim sekaligus.

> Sukses atau gagal ditebak dari pesan alert di halaman balasan server. Kalau tanda ✓/✗ tidak cocok
> dengan kenyataan di web, kirim contoh HTML balasannya supaya deteksinya bisa disesuaikan.
