# CycleTime Tracker Web Application

ระบบบันทึกและวิเคราะห์ข้อมูล Cycle Time (ย้ายจาก Google Apps Script + Google Sheets สู่ Node.js + MySQL)

## Tech Stack
- **Backend:** Node.js (Express.js)
- **Database:** MySQL 8.0+
- **Frontend:** HTML5, Bootstrap 5, Chart.js (Static files in `/public`)

## ขั้นตอนการติดตั้งบน Server (Deployment Guide)

### 1. เตรียมฐานข้อมูล (Database Setup)
- นำเข้าไฟล์ `database.sql` เข้าสู่ MySQL Server เพื่อสร้างฐานข้อมูล `cycletime_db` และตารางทั้งหมด

### 2. ตั้งค่า Environment Variables
- คัดลอกไฟล์ `.env.example` เป็น `.env`
```bash
cp .env.example .env
