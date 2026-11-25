require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const path = require('path');

const pool = require('./config/db');
const { generateDashboardExcel, generateMatrixExcel } = require('./services/excelService');

// ตรวจสอบว่าตั้งค่า .env ครบก่อนสตาร์ทเซิร์ฟเวอร์ (ไม่ใช้รหัสผ่านสำรองในโค้ด)

const app = express();

// เพิ่ม Security Headers (ปิด CSP ชั่วคราวเพราะ index.html ยังใช้ inline script และ CDN)
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));


const parseJsonSafe = (val, fallback = []) => {
  if (!val) return fallback;
  if (typeof val === 'object') return val;
  try { return JSON.parse(val); } catch (e) { return fallback; }
};

// 1. getInitialConfig
app.get('/api/initial-config', async (req, res) => {
  try {
    const [masters] = await pool.query('SELECT line, model, cavity, routing_json FROM config_master');
    let lineModelMap = {};
    let modelRoutingMap = {};
    let modelCavityMap = {};
    let lines = [];

    for (const row of masters) {
      const l = (row.line || '').trim();
      const m = (row.model || '').trim();
      const c = parseInt(row.cavity) || 1;
      if (l) {
        if (!lineModelMap[l]) { lineModelMap[l] = []; lines.push(l); }
        if (m && !lineModelMap[l].find(x => x.model === m)) {
          lineModelMap[l].push({ model: m, takt: 0 });
        }
      }
      if (m) {
        modelCavityMap[m] = c;
        modelRoutingMap[m] = parseJsonSafe(row.routing_json, []);
      }
    }

    const [logs] = await pool.query('SELECT DISTINCT model, session_tag FROM log_time_study WHERE model IS NOT NULL AND session_tag IS NOT NULL');
    let modelSessionMap = {};
    for (const row of logs) {
      const m = row.model.trim();
      const s = row.session_tag.trim();
      if (m && s) {
        if (!modelSessionMap[m]) modelSessionMap[m] = [];
        if (!modelSessionMap[m].includes(s)) modelSessionMap[m].push(s);
      }
    }

    res.json({
      lines: [...new Set(lines)],
      lineModelMap,
      modelRoutingMap,
      modelCavityMap,
      modelSessionMap,
      isStaff: true,
      currentUser: 'local-admin@company.com'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. updateModelConfig
app.post('/api/update-model-config', async (req, res) => {
  try {
    const { line, model, cavity, routingArray } = req.body;
    const routingStr = JSON.stringify(routingArray || []);
    const [rows] = await pool.query('SELECT id FROM config_master WHERE model = ?', [model]);
    if (rows.length > 0) {
      await pool.query('UPDATE config_master SET cavity = ?, routing_json = ?, timestamp = NOW() WHERE model = ?', [cavity, routingStr, model]);
    } else {
      await pool.query('INSERT INTO config_master (line, model, cavity, routing_json) VALUES (?, ?, ?, ?)', [line || '-', model, cavity, routingStr]);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 3. manageConfigItem
app.post('/api/manage-config', async (req, res) => {
  try {
    const { action, type, line, value } = req.body;
    if (action === 'add' && type === 'Model') {
      const [rows] = await pool.query('SELECT id FROM config_master WHERE model = ?', [value.trim()]);
      if (rows.length > 0) return res.json({ success: true, message: 'Model already exists' });
      await pool.query('INSERT INTO config_master (line, model, cavity, routing_json) VALUES (?, ?, 1, ?)', [line || '-', value.trim(), '[]']);
      return res.json({ success: true });
    } else if (action === 'delete' && type === 'Model') {
      await pool.query('DELETE FROM config_master WHERE model = ?', [value.trim()]);
      return res.json({ success: true });
    }
    res.json({ success: false, message: 'Invalid Action' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 4. Master Data CRUD
app.get('/api/master', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT line, model, cavity, routing_json FROM config_master ORDER BY model ASC');
    res.json(rows.map(r => ({
      line: r.line,
      model: r.model,
      cavity: r.cavity,
      routingStr: typeof r.routing_json === 'string' ? r.routing_json : JSON.stringify(r.routing_json || [])
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/master', async (req, res) => {
  try {
    const { oldModelName, line, model, cavity, routingStr } = req.body;
    const searchModel = (oldModelName || model).trim().toUpperCase();
    const [existing] = await pool.query('SELECT id FROM config_master WHERE model = ?', [searchModel]);

    if (existing.length > 0) {
      await pool.query('UPDATE config_master SET line = ?, model = ?, cavity = ?, routing_json = ?, timestamp = NOW() WHERE id = ?', [line, model, cavity, routingStr, existing[0].id]);
    } else {
      const [dup] = await pool.query('SELECT id FROM config_master WHERE model = ?', [model.trim().toUpperCase()]);
      if (dup.length > 0) return res.json({ success: false, message: 'Model Name already exists!' });
      await pool.query('INSERT INTO config_master (line, model, cavity, routing_json) VALUES (?, ?, ?, ?)', [line, model, cavity, routingStr]);
    }
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

app.delete('/api/master/:modelName', async (req, res) => {
  try {
    const [result] = await pool.query('DELETE FROM config_master WHERE model = ?', [req.params.modelName.trim().toUpperCase()]);
    if (result.affectedRows > 0) return res.json({ success: true });
    res.json({ success: false, message: 'Model not found.' });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// 5. getCompletedStations
app.get('/api/completed-stations', async (req, res) => {
  try {
    const { model, sessionTag } = req.query;
    const [rows] = await pool.query(
      'SELECT DISTINCT station FROM log_time_study WHERE model = ? AND session_tag = ? AND station IS NOT NULL',
      [(model || '').trim(), (sessionTag || '').trim()]
    );
    res.json(rows.map(r => r.station.trim()));
  } catch (err) {
    res.json([]);
  }
});

// 6. getAvailablePullData
app.get('/api/pull-data', async (req, res) => {
  try {
    const { stationName, excludeModel, excludeSession } = req.query;
    const getBaseModelName = (name) => (name ? name.split('(')[0].trim().toUpperCase() : '');
    const targetBaseModel = getBaseModelName(excludeModel);

    const [rows] = await pool.query('SELECT * FROM log_time_study WHERE station = ? ORDER BY id DESC', [stationName]);
    let results = [];
    let seenKeys = new Set();

    for (const r of rows) {
      if (r.model === excludeModel && r.session_tag === excludeSession) continue;
      if (getBaseModelName(r.model) === targetBaseModel) {
        const key = `${r.model}_${r.session_tag}`;
        if (!seenKeys.has(key)) {
          seenKeys.add(key);
          const rData = [r.r1, r.r2, r.r3, r.r4, r.r5, r.r6, r.r7, r.r8, r.r9, r.r10].map(v => (v !== null ? parseFloat(v) : ''));
          results.push({
            model: r.model,
            session: r.session_tag,
            totalCT: parseFloat(r.total_ct) || 0,
            r: rData,
            remarks: parseJsonSafe(r.remarks_json, []),
            operator: r.operator || '',
            checker: r.checker || ''
          });
        }
      }
    }
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 7. saveTimeStudyDataFlat + updateSummaryMatrix
app.post('/api/time-study', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const payload = req.body;
    const rounds = [];
    const remarks = [];

    for (let i = 0; i < 10; i++) {
      const item = (payload.cycles && payload.cycles[i]) ? payload.cycles[i] : {};
      const ct = parseFloat(item.cycleTime);
      rounds.push(isNaN(ct) ? 0 : ct);
      remarks.push(item.remark ? item.remark.toString().trim() : '');
    }

    await conn.query(
      `INSERT INTO log_time_study 
      (session_tag, line, model, station, cavity, total_ct, r1, r2, r3, r4, r5, r6, r7, r8, r9, r10, remarks_json, operator, checker)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        payload.sessionTag || '', payload.line || '-', payload.model || '', payload.station || '',
        parseInt(payload.cavity) || 1, parseFloat(payload.totalCycle) || 0,
        ...rounds, JSON.stringify(remarks), payload.operator || '', payload.checker || ''
      ]
    );

    // Update Summary Matrix
    const model = (payload.model || '').trim();
    const sessionTag = (payload.sessionTag || '').trim();
    const station = (payload.station || '').trim();
    const payloadLine = (payload.line || '-').trim();
    const avgCt = parseFloat(payload.totalCycle) || 0;
    const op = payload.operator || '-';
    const chk = payload.checker || '-';

    if (model && sessionTag && station) {
      const [configRows] = await conn.query('SELECT routing_json FROM config_master WHERE model = ?', [model]);
      let totalRequiredStations = [];
      if (configRows.length > 0) {
        const routingArr = parseJsonSafe(configRows[0].routing_json, []);
        routingArr.forEach(mSt => {
          if (mSt.subs && Array.isArray(mSt.subs)) {
            mSt.subs.forEach(sSt => totalRequiredStations.push(`${mSt.name} (${sSt.name})`));
          }
        });
      }
      if (totalRequiredStations.length === 0) totalRequiredStations.push(station);

      let [sessionRows] = await conn.query('SELECT * FROM summary_matrix WHERE model = ? AND session_tag = ?', [model, sessionTag]);
      if (sessionRows.length === 0) {
        for (const st of totalRequiredStations) {
          await conn.query(
            'INSERT INTO summary_matrix (model, session_tag, station, progress, operator, checker, line) VALUES (?, ?, ?, "0%", "-", "-", "-")',
            [model, sessionTag, st]
          );
        }
        [sessionRows] = await conn.query('SELECT * FROM summary_matrix WHERE model = ? AND session_tag = ?', [model, sessionTag]);
      }

      let targetRow = sessionRows.find(r => r.station === station && (r.line || '').trim() === payloadLine);
      if (!targetRow) {
        targetRow = sessionRows.find(r => r.station === station && (!r.line || r.line === '-' || r.line === ''));
      }

      const roundCols = rounds.map(v => (v === 0 ? null : v));
      if (targetRow) {
        await conn.query(
          `UPDATE summary_matrix SET avg_cycle_time = ?, r1=?, r2=?, r3=?, r4=?, r5=?, r6=?, r7=?, r8=?, r9=?, r10=?, operator=?, checker=?, line=? WHERE id = ?`,
          [avgCt, ...roundCols, op, chk, payloadLine, targetRow.id]
        );
      } else {
        await conn.query(
          `INSERT INTO summary_matrix (model, session_tag, station, avg_cycle_time, r1, r2, r3, r4, r5, r6, r7, r8, r9, r10, operator, checker, line)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [model, sessionTag, station, avgCt, ...roundCols, op, chk, payloadLine]
        );
      }

      const [updatedRows] = await conn.query('SELECT * FROM summary_matrix WHERE model = ? AND session_tag = ?', [model, sessionTag]);
      let completedStationsSet = new Set();
      let totalCT = 0;
      let maxCT = 0;
      let bottleneck = '-';

      updatedRows.forEach(sr => {
        const val = parseFloat(sr.avg_cycle_time);
        if (!isNaN(val) && val > 0) {
          completedStationsSet.add(sr.station);
          totalCT += val;
          if (val > maxCT) {
            maxCT = val;
            bottleneck = `${sr.station} [Line: ${sr.line || '-'}]`;
          }
        }
      });

      const progress = Math.min(100, Math.round((completedStationsSet.size / totalRequiredStations.length) * 100)) + '%';
      await conn.query(
        'UPDATE summary_matrix SET progress = ?, total_model_ct = ?, bottleneck = ?, timestamp = NOW() WHERE model = ? AND session_tag = ?',
        [progress, totalCT.toFixed(2), bottleneck, model, sessionTag]
      );
    }

    await conn.commit();
    res.json({ success: true });
  } catch (err) {
    await conn.rollback();
    res.json({ success: false, message: 'Backend Error: ' + err.message });
  } finally {
    conn.release();
  }
});

// 8. getDashboardData
app.post('/api/dashboard', async (req, res) => {
  try {
    const { modelName, lineName, targetSessionTags } = req.body;
    const [rawData] = await pool.query('SELECT * FROM log_time_study WHERE model = ?', [(modelName || '').trim()]);

    let tempStationGroups = {};
    let availableSessions = new Set();
    let availableLines = new Set();

    rawData.forEach(r => {
      const sTag = (r.session_tag || 'Default Version').trim();
      const sLine = (r.line || '-').trim();
      if (sTag) availableSessions.add(sTag);
      if (sLine && sLine !== '-') availableLines.add(sLine);
    });

    const arrSessions = Array.from(availableSessions).reverse();
    const arrLines = Array.from(availableLines).sort();
    const activeSessions = (targetSessionTags && targetSessionTags.length > 0) ? targetSessionTags : (arrSessions.length > 0 ? [arrSessions[0]] : []);
    const activeLine = lineName || 'ALL';

    rawData.forEach(r => {
      const rTag = (r.session_tag || 'Default Version').trim();
      const rLine = (r.line || '-').trim();
      const passSession = activeSessions.includes(rTag) || activeSessions.includes('ALL');
      const passLine = activeLine === 'ALL' || rLine === activeLine;

      if (passSession && passLine) {
        const stNameFull = r.station.trim();
        let mainSt = stNameFull, subSt = '-';
        const match = stNameFull.match(/^(.*?)\s*\((.*?)\)$/);
        if (match) { mainSt = match[1].trim(); subSt = match[2].trim(); }

        const rowEffCavity = parseFloat(r.cavity) || 1;
        if (!tempStationGroups[stNameFull]) {
          tempStationGroups[stNameFull] = {
            station: stNameFull, mainStation: mainSt, subStation: subSt,
            ops: new Set(), chks: new Set(),
            rValues: [[], [], [], [], [], [], [], [], [], []],
            allValidR: []
          };
        }

        if (r.operator && r.operator !== '-') tempStationGroups[stNameFull].ops.add(r.operator.trim());
        if (r.checker && r.checker !== '-') tempStationGroups[stNameFull].chks.add(r.checker.trim());

        const rDataRaw = [r.r1, r.r2, r.r3, r.r4, r.r5, r.r6, r.r7, r.r8, r.r9, r.r10];
        rDataRaw.forEach((val, idx) => {
          const num = parseFloat(val);
          if (!isNaN(num) && num > 0) {
            const actualTime = num / rowEffCavity;
            tempStationGroups[stNameFull].rValues[idx].push(actualTime);
            tempStationGroups[stNameFull].allValidR.push(actualTime);
          }
        });
      }
    });

    const formatNames = (nameSet) => {
      const arr = Array.from(nameSet);
      if (arr.length === 0) return '-';
      if (arr.length <= 3) return arr.join(', ');
      return arr.slice(0, 3).join(', ') + ` (+${arr.length - 3} others)`;
    };

    let result = [];
    Object.values(tempStationGroups).forEach(st => {
      let trueAvg = 0;
      let rList = [...st.allValidR];
      if (rList.length >= 3) {
        rList.sort((a, b) => a - b);
        const trimmed = rList.slice(1, -1);
        trueAvg = (trimmed.reduce((a, b) => a + b, 0) / trimmed.length).toFixed(2);
      } else if (rList.length > 0) {
        trueAvg = (rList.reduce((a, b) => a + b, 0) / rList.length).toFixed(2);
      }

      const finalR = st.rValues.map(rArr => {
        if (rArr.length === 0) return '';
        return parseFloat((rArr.reduce((a, b) => a + b, 0) / rArr.length).toFixed(2));
      });

      result.push({
        station: st.station, mainStation: st.mainStation, subStation: st.subStation,
        operator: formatNames(st.ops), checker: formatNames(st.chks),
        total: parseFloat(trueAvg),
        allRounds: st.allValidR,
        r1: finalR[0], r2: finalR[1], r3: finalR[2], r4: finalR[3], r5: finalR[4],
        r6: finalR[5], r7: finalR[6], r8: finalR[7], r9: finalR[8], r10: finalR[9]
      });
    });

    const nowStr = new Date().toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    res.json({
      data: result,
      lastUpdated: nowStr,
      panelCavity: '-',
      availableSheets: arrSessions,
      availableLines: arrLines,
      activeSessions,
      activeLine
    });
  } catch (err) {
    res.json({ data: [], message: err.message });
  }
});

// 9. getAllMatrixSummaryData
app.get('/api/matrix', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM summary_matrix ORDER BY id ASC');
    const data = rows.map(r => {
      const d = new Date(r.timestamp);
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const ts = `${String(d.getDate()).padStart(2, '0')}-${months[d.getMonth()]}-${d.getFullYear()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      return {
        timestamp: ts,
        model: r.model || '-',
        session: r.session_tag || '-',
        station: r.station || '-',
        progress: r.progress || '0%',
        totalModelCT: parseFloat(r.total_model_ct) || 0,
        bottleneck: r.bottleneck || '-',
        avgCT: parseFloat(r.avg_cycle_time) || 0,
        r1: r.r1, r2: r.r2, r3: r.r3, r4: r.r4, r5: r.r5,
        r6: r.r6, r7: r.r7, r8: r.r8, r9: r.r9, r10: r.r10,
        operator: r.operator || '-',
        checker: r.checker || '-',
        line: r.line || '-'
      };
    });
    res.json({ success: true, data });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// 10. Export Excel (Dashboard & Matrix)
app.post('/api/export/dashboard', async (req, res) => {
  try {
    await generateDashboardExcel(res, req.body);
  } catch (err) {
    console.error('Export Dashboard Error:', err);
    res.status(500).json({ success: false, message: 'Export failed' });
  }
});

app.post('/api/export/matrix', async (req, res) => {
  try {
    await generateMatrixExcel(res, req.body);
  } catch (err) {
    console.error('Export Matrix Error:', err);
    res.status(500).json({ success: false, message: 'Export failed' });
  }
});



// Health Check Endpoint สำหรับทีม IT / Docker / Monitoring
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', database: 'connected' });
  } catch (err) {
    res.status(500).json({ status: 'error', database: 'disconnected' });
  }
});

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));

// ปิดการเชื่อมต่อ Database อย่างปลอดภัยเมื่อสั่งหยุด Server
const shutdown = async () => {
  console.log('Shutting down server...');
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);