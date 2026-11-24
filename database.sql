CREATE DATABASE IF NOT EXISTS cycletime_db CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE cycletime_db;

CREATE TABLE IF NOT EXISTS config_master (
    id INT AUTO_INCREMENT PRIMARY KEY,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    line VARCHAR(50) DEFAULT '-',
    model VARCHAR(100) NOT NULL UNIQUE,
    cavity INT DEFAULT 1,
    routing_json JSON
);

CREATE TABLE IF NOT EXISTS config_staff (
    id INT AUTO_INCREMENT PRIMARY KEY,
    email VARCHAR(150) NOT NULL UNIQUE,
    name VARCHAR(100),
    role VARCHAR(50) DEFAULT 'Staff',
    added_date DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS log_time_study (
    id INT AUTO_INCREMENT PRIMARY KEY,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    session_tag VARCHAR(150),
    line VARCHAR(50),
    model VARCHAR(100),
    station VARCHAR(150),
    cavity INT DEFAULT 1,
    total_ct DECIMAL(10,2),
    r1 DECIMAL(10,2), r2 DECIMAL(10,2), r3 DECIMAL(10,2), r4 DECIMAL(10,2), r5 DECIMAL(10,2),
    r6 DECIMAL(10,2), r7 DECIMAL(10,2), r8 DECIMAL(10,2), r9 DECIMAL(10,2), r10 DECIMAL(10,2),
    remarks_json JSON,
    operator VARCHAR(100),
    checker VARCHAR(100),
    INDEX idx_model_session (model, session_tag),
    INDEX idx_station (station)
);

CREATE TABLE IF NOT EXISTS summary_matrix (
    id INT AUTO_INCREMENT PRIMARY KEY,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    model VARCHAR(100),
    session_tag VARCHAR(150),
    station VARCHAR(150),
    progress VARCHAR(20) DEFAULT '0%',
    total_model_ct DECIMAL(10,2) DEFAULT 0,
    bottleneck VARCHAR(200) DEFAULT '-',
    avg_cycle_time DECIMAL(10,2) DEFAULT 0,
    r1 DECIMAL(10,2), r2 DECIMAL(10,2), r3 DECIMAL(10,2), r4 DECIMAL(10,2), r5 DECIMAL(10,2),
    r6 DECIMAL(10,2), r7 DECIMAL(10,2), r8 DECIMAL(10,2), r9 DECIMAL(10,2), r10 DECIMAL(10,2),
    operator VARCHAR(100) DEFAULT '-',
    checker VARCHAR(100) DEFAULT '-',
    line VARCHAR(50) DEFAULT '-',
    INDEX idx_matrix_lookup (model, session_tag, station, line)
);