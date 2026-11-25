  // ตัวแปลงคำสั่ง google.script.run เดิม ให้ยิง API เข้าหา Node.js + MySQL อัตโนมัติ (ฉบับแก้ไข)
function createGasRunner(onSuccess = () => {}, onFailure = (err) => console.error(err)) {
  return new Proxy({}, {
    get(_, prop) {
      if (prop === 'withSuccessHandler') {
        return (fn) => createGasRunner(fn, onFailure);
      }
      if (prop === 'withFailureHandler') {
        return (fn) => createGasRunner(onSuccess, fn);
      }

      return function(...args) {
        const callApi = async (url, options = {}) => {
          const res = await fetch(url, {
            headers: { 'Content-Type': 'application/json' },
            ...options
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.message || data.error || 'Server Error');
          return data;
        };

        let promise;
        switch (prop) {
          case 'getInitialConfig':
            promise = callApi('/api/initial-config').then(res => {
              res.lastModel = localStorage.getItem('TS_LAST_MODEL') || '';
              res.lastLine = localStorage.getItem('TS_LAST_LINE') || '';
              return res;
            });
            break;
          case 'saveLastState':
            if (args[0]) localStorage.setItem('TS_LAST_LINE', args[0]);
            if (args[1]) localStorage.setItem('TS_LAST_MODEL', args[1]);
            promise = Promise.resolve({ success: true });
            break;
          case 'updateModelConfig':
            promise = callApi('/api/update-model-config', {
              method: 'POST',
              body: JSON.stringify({ line: args[0], model: args[1], cavity: args[2], routingArray: args[3] })
            });
            break;
          case 'manageConfigItem':
            promise = callApi('/api/manage-config', {
              method: 'POST',
              body: JSON.stringify({ action: args[0], type: args[1], line: args[2], value: args[3] })
            });
            break;
          case 'getMasterDataList':
            promise = callApi('/api/master');
            break;
          case 'saveMasterModelData':
            promise = callApi('/api/master', {
              method: 'POST',
              body: JSON.stringify({ oldModelName: args[0], line: args[1], model: args[2], cavity: args[3], routingStr: args[4] })
            });
            break;
          case 'deleteMasterModelData':
            promise = callApi(`/api/master/${encodeURIComponent(args[0])}`, { method: 'DELETE' });
            break;
          case 'getCompletedStations':
            promise = callApi(`/api/completed-stations?model=${encodeURIComponent(args[0] || '')}&sessionTag=${encodeURIComponent(args[1] || '')}`);
            break;
          case 'getAvailablePullData':
            promise = callApi(`/api/pull-data?stationName=${encodeURIComponent(args[0] || '')}&excludeModel=${encodeURIComponent(args[1] || '')}&excludeSession=${encodeURIComponent(args[2] || '')}`);
            break;
          case 'saveTimeStudyDataFlat':
            promise = callApi('/api/time-study', {
              method: 'POST',
              body: JSON.stringify(args[0])
            });
            break;
          case 'getDashboardData':
            promise = callApi('/api/dashboard', {
              method: 'POST',
              body: JSON.stringify({ modelName: args[0], lineName: args[1], targetSessionTags: args[2], archiveId: args[3] })
            });
            break;
          case 'getAllMatrixSummaryData':
            promise = callApi('/api/matrix');
            break;
          default:
            promise = Promise.reject(new Error(`Unknown API method: ${String(prop)}`));
        }

        promise.then(onSuccess).catch(onFailure);
      };
    }
  });
}

window.google = {
  script: {
    run: createGasRunner()
  }
};
  
  let allLineModelMap = {}; let allModelRoutings = {}; let allModelCavities = {};
  let allModelSessions = {}; 
  let currentRouting = []; 
  let currentMainIndex = -1;
  // [เพิ่มใหม่] ตัวแปรจัดการ SortableJS ในหน้า Master Data
  let masterMainSortableInstance = null;
  let masterSubSortableInstances = [];
  // [เพิ่มใหม่] ตัวแปรเก็บรายการ Master Data ทั้งหมด เพื่อใช้กรอง Real-time Filter ฝั่ง Client-side
  let allMasterDataList = [];
  let currentModel = "", currentLine = "", currentStation = "", currentCavity = 1, webChartInstance = null;
  let currentDashboardData = []; 
  let currentSessionTag = "";
  let currentDashboardCavity = 1; 
  let mainSortableInstance = null;
  let subSortableInstance = null;
  let currentEffCavity = 1;
  let stopwatchStartTime = 0; let stopwatchElapsedTime = 0; let isStopwatchRunning = false; let stopwatchAnimationFrame;
  let globalAvailableSheets = []; 
  let isStaffMode = false; 
  let isNavigatedFromMatrix = false;

  let currentRound = 1;
  let lastLapTime = 0;

  const swalModern = Swal.mixin({
    customClass: { confirmButton: 'btn btn-primary px-4 shadow-sm', cancelButton: 'btn btn-outline-secondary px-4', input: 'form-control' },
    buttonsStyling: false
  });

  document.addEventListener("DOMContentLoaded", () => { loadInitialData(); });
  
  function loadInitialData() {
    google.script.run
      .withSuccessHandler(function(res) {
        document.getElementById("loading-config").classList.add("d-none");
        document.getElementById("config-ready").classList.remove("d-none");
        
        isStaffMode = res.isStaff; 
        applyRoleRestrictions();   
        allModelRoutings = res.modelRoutingMap;
        allModelCavities = res.modelCavityMap || {}; 
        allModelSessions = res.modelSessionMap || {}; 
        
        if ($('#model-select').hasClass("select2-hidden-accessible")) $('#model-select').select2('destroy');
        
        $('#model-select').empty().append('<option value="">-- Type to search Model --</option>');
        
        let allModels = Object.keys(allModelRoutings).sort();
        allModels.forEach(m => {
          if(m && m !== "-") { $('#model-select').append(new Option(m, m)); }
        });
        
        $('#model-select').select2({ theme: 'bootstrap-5', width: '100%', placeholder: '-- Type to search Model --' });

        $('#model-select').on('change', function() {
          var selectedModel = $(this).val();
          if (selectedModel && allModelCavities[selectedModel] !== undefined) {
            document.getElementById("cavity-input").value = allModelCavities[selectedModel];
          } else { document.getElementById("cavity-input").value = 1; }
          
          let existingSelect = $('#existing-session-select');
          existingSelect.empty();
          existingSelect.append(new Option("✨ Create New Version (Use settings below)", ""));
          
          if (selectedModel && allModelSessions[selectedModel]) {
            // [แก้ไข] จำกัดการแสดงผลเฉพาะ 5 Session ล่าสุดเพื่อแก้ปัญหา UI รก
            let sessions = [...allModelSessions[selectedModel]].reverse().slice(0, 5);
            sessions.forEach(tag => {
              existingSelect.append(new Option(`🔄 Continue: ${tag}`, tag));
            });
          }
        });

        $(document).on('change', '#existing-session-select', function() {
           if($(this).val() !== "") {
               $('#new-session-setup').css('opacity', '0.4').css('pointer-events', 'none');
           } else {
               $('#new-session-setup').css('opacity', '1').css('pointer-events', 'auto');
           }
        });

        if (res.lastModel) {
          setTimeout(() => { 
            let cleanModel = res.lastModel.trim();
            if (cleanModel && cleanModel !== "-" && $('#model-select option[value="' + cleanModel + '"]').length > 0) {
              $('#model-select').val(cleanModel).trigger('change.select2').trigger('change'); 
            }
          }, 100);
        }
      })
      .withFailureHandler(function(err) {
        document.getElementById("loading-config").innerHTML = `<div class="text-danger fw-bold"><i class="fa-solid fa-triangle-exclamation fa-2x mb-2"></i><br>Database Connection Failed:<br>${err.message}</div>`;
      })
      .getInitialConfig();
  }

  let completedStations = []; 

  function applyRoleRestrictions() {
    if (!isStaffMode) {
      $('.btn-outline-success, .btn-outline-danger').filter('[title*="Model"]').addClass('d-none');
      $('button[onclick="openMatrixSummary()"]').parent().addClass('d-none'); 
      $('#cavity-input').closest('.col-md-4').addClass('d-none');
      $('.col-md-8').removeClass('col-md-8').addClass('col-md-12');
      $('#type-imp').next('label').addClass('d-none');
      $('#type-base').next('label').addClass('d-none');
      $('#session-name').attr('placeholder', 'Enter Remark / Session Info...'); 
      $('#type-base').closest('.col-md-5').addClass('d-none');
      $('#session-name').closest('.col-md-7').removeClass('col-md-7').addClass('col-12');
      $('.add-btn').addClass('d-none');
    } else {
      // [เพิ่มใหม่] เรียกฟังก์ชันเพื่อแสดงปุ่ม Master Data สำหรับ Staff
      checkMasterPermission();
      // [เพิ่มใหม่] โชว์ปุ่ม Archive ให้ Staff
    }
  }

  function manageItem(action, type) { 
    if (action === 'add') {
      swalModern.fire({
        title: `Add New Model`,
        html: `<input id="swal-m" class="form-control text-center fw-bold" placeholder="Model Name" style="text-transform: uppercase;">`,
        showCancelButton: true, confirmButtonText: 'Save',
        preConfirm: () => {
          let m = document.getElementById('swal-m').value.trim().toUpperCase();
          if(!m) Swal.showValidationMessage('Model name is required');
          return { model: m };
        }
      }).then((res) => {
        if(res.isConfirmed) {
          swalModern.fire({title: 'Saving...', allowOutsideClick: false, didOpen: () => {Swal.showLoading()}});
          
          google.script.run
            .withSuccessHandler((response) => { 
              swalModern.close(); 
              swalModern.fire('Success', 'Model updated successfully!', 'success'); 
              loadInitialData(); 
            })
            .withFailureHandler((err) => { 
              swalModern.close(); 
              swalModern.fire('Error', err.message, 'error'); 
            })
            .manageConfigItem('add', 'Model', '-', res.value.model);
        }
      });
    } else {
        let val = $('#model-select').val();
        if (!val) return swalModern.fire('Warning', `Please select a Model first.`, 'warning');
        swalModern.fire({
          title: `Delete ${val}?`, text: `Are you sure you want to delete this?`, icon: 'warning', 
          showCancelButton: true, confirmButtonText: 'Delete', customClass: { confirmButton: 'btn btn-danger px-4', cancelButton: 'btn btn-outline-secondary px-4' }
        }).then((res) => {
          if(res.isConfirmed) {
            swalModern.fire({title: 'Deleting...', allowOutsideClick: false, didOpen: () => {Swal.showLoading()}});
            google.script.run.withSuccessHandler(() => { swalModern.fire('Success', '', 'success'); loadInitialData(); }).withFailureHandler((err) => { swalModern.fire('Error', err.message, 'error'); }).manageConfigItem('delete', 'Model', '-', val);
          }
         });
      }
    }

  function updateCavityBackend() {
      let rawCavity = parseInt(document.getElementById("cavity-input").value);
      currentCavity = (isNaN(rawCavity) || rawCavity < 1) ? 1 : rawCavity;
      let line = currentLine || "-"; 
      let model = $('#model-select').val();

      if(model) {
         allModelCavities[model] = currentCavity;
         google.script.run
           .withFailureHandler((err) => {
             console.error("Update Cavity Failed:", err.message);
             swalModern.fire('Error', 'Failed to update Cavity: ' + err.message, 'error');
           })
           .updateModelConfig(line, model, currentCavity, allModelRoutings[model] || []);
      }
  }

  function goToLayout() { 
    try {
      currentLine = "-";
      currentModel = $('#model-select').val();
      let rawCavity = parseInt(document.getElementById("cavity-input").value);
      currentCavity = (isNaN(rawCavity) || rawCavity < 1) ? 1 : rawCavity;
      document.getElementById("cavity-input").value = currentCavity;
      
      if (!currentModel) { return swalModern.fire('Warning', 'Please select a Model.', 'warning'); }

      let existingTag = document.getElementById("existing-session-select").value;
      
      if (!isStaffMode) {
        if (existingTag) {
          currentSessionTag = existingTag; 
        } else {
          let rawName = document.getElementById('session-name').value.trim();
          if (!rawName) {
             let d = new Date();
             let hh = String(d.getHours()).padStart(2, '0');
             let mm = String(d.getMinutes()).padStart(2, '0');
             rawName = `${hh}:${mm}`;
          }
          currentSessionTag = `[Base: ${rawName}]`;
        }
      } else {
        if (existingTag) {
          currentSessionTag = existingTag;
        } else {
          let type = document.querySelector('input[name="study-type-radio"]:checked').value;
          let rawName = document.getElementById('session-name').value.trim();
          if (!rawName) {
             let d = new Date();
             let hh = String(d.getHours()).padStart(2, '0');
             let mm = String(d.getMinutes()).padStart(2, '0');
             rawName = `${hh}:${mm}`;
          }
          currentSessionTag = `[${type}: ${rawName}]`;
        }
      }
      
      allModelCavities[currentModel] = currentCavity;
      let fetchedRouting = allModelRoutings[currentModel] || [];

      if (fetchedRouting.length > 0 && !fetchedRouting[0].subs) {
         let newRouting = [];
         fetchedRouting.forEach(oldSt => {
            newRouting.push({
               name: oldSt.name,
               subs: [ { name: oldSt.sub || "Default", type: oldSt.type, unit: oldSt.unit } ]
            });
         });
         fetchedRouting = newRouting;
      }

      currentRouting = fetchedRouting;
      if (currentRouting.length === 0) {
        currentRouting = [
          { name: "INKJET MARKING", subs: [{name: "Main", unit: "Panel"}] }, 
          { name: "SMT B SIDE", subs: [{name: "Main", unit: "Panel"}] }, 
          { name: "SMT A SIDE", subs: [{name: "Main", unit: "Panel"}] }
        ];
        saveCurrentRoutingToBackend(); 
      }

      swalModern.fire({
        title: 'Loading Data...',
        text: 'Checking station status...',
        allowOutsideClick: false,
        didOpen: () => { Swal.showLoading(); }
      });

      google.script.run
        .withSuccessHandler((completedList) => {
          swalModern.close();
          completedStations = completedList || [];

          renderMainStations();
          google.script.run.withFailureHandler(console.error).saveLastState(currentLine, currentModel, currentCavity);
          document.getElementById("display-model-layout").textContent = `${currentModel} (Cavity: ${currentCavity})`; 
          
          const sessionBadge = document.getElementById("display-session-layout");
          sessionBadge.textContent = "📍 Project: " + currentSessionTag;
          sessionBadge.classList.remove("d-none");

          document.getElementById("section-select").classList.add("d-none");
          document.getElementById("section-layout").classList.remove("d-none"); 
        })
        .withFailureHandler((err) => {
          swalModern.close();
          swalModern.fire('Error', 'Failed to fetch station status: ' + err.message, 'error');
        })
        .getCompletedStations(currentModel, currentSessionTag);

    } catch (e) { swalModern.fire('Error', 'System Error: ' + e.message, 'error'); }
  }

  function renderMainStations() { 
    const container = document.getElementById("main-station-container");
    container.innerHTML = "";
    if (currentRouting.length === 0) { container.innerHTML = `<div class="text-center text-muted py-4">No main stations configured.</div>`; return; }
    
    currentRouting.forEach((st, index) => {
      let subsCount = st.subs ? st.subs.length : 0;
      let isMainCompleted = false;
      if (subsCount > 0) {
        isMainCompleted = st.subs.every(sub => {
          let fullName = `${st.name} (${sub.name})`;
          return completedStations.includes(fullName);
        });
      }

      let statusClass = isMainCompleted ? "completed" : "manual";
      
      let actionHtml = "";
      if (isStaffMode) {
        actionHtml = `
          <button class="btn-icon edit shadow-sm" onclick="promptEditMainStation(${index})" title="Edit Main Station"><i class="fa-solid fa-pen"></i></button>
          <button class="btn-icon enter d-flex align-items-center gap-2 shadow-sm" onclick="openSubStations(${index})"><i class="fa-solid fa-folder-open"></i> Manage Subs</button>
          <button class="btn-icon del shadow-sm" onclick="confirmDeleteMainStation(${index}, '${st.name}')" title="Delete"><i class="fa-solid fa-trash-can"></i></button>
        `;
      } else {
        actionHtml = `<button class="btn-icon enter d-flex align-items-center gap-2 shadow-sm" onclick="openSubStations(${index})"><i class="fa-solid fa-folder-open"></i> View Subs</button>`;
      }

      container.innerHTML += `
         <div class="station-item ${statusClass}" data-index="${index}">
          ${isStaffMode ? '<div class="drag-handle" title="Drag to reorder"><i class="fa-solid fa-grip-vertical"></i></div>' : ''}
          <div class="station-seq">${index + 1}</div>
          <div class="station-content">
            <h4 class="station-name">${st.name}</h4>
            <div><span class="badge bg-secondary bg-opacity-10 text-secondary border border-secondary mt-1"><small>${subsCount} Sub-Stations</small></span></div>
          </div>
          <div class="station-actions">${actionHtml}</div>
        </div>
      `;
     });

    if(mainSortableInstance) mainSortableInstance.destroy();
    if(isStaffMode) {
      mainSortableInstance = new Sortable(container, {
        handle: '.drag-handle', animation: 200, ghostClass: 'bg-light',
        onEnd: function (evt) {
          let movedItem = currentRouting.splice(evt.oldIndex, 1)[0];
          currentRouting.splice(evt.newIndex, 0, movedItem);
          saveCurrentRoutingToBackend(); renderMainStations(); 
        }
      });
    }
  }

  function promptAddMainStation() {
    swalModern.fire({
      title: 'Add Main Station',
      html: `<input id="swal-main-name" class="form-control text-center fs-5 fw-bold" placeholder="Main Station Name (e.g. ICT, FCT)" style="text-transform: uppercase;">`,
      showCancelButton: true, confirmButtonText: 'Add',
      preConfirm: () => {
        const name = document.getElementById('swal-main-name').value.trim().toUpperCase();
        if (!name) Swal.showValidationMessage('Main Station name is required');
        return name;
      }
    }).then((res) => {
      if (res.isConfirmed) {
        currentRouting.push({ name: res.value, subs: [] });
        renderMainStations(); saveCurrentRoutingToBackend();
      }
    });
  }

  function promptEditMainStation(index) {
    let st = currentRouting[index];
    swalModern.fire({
      title: 'Edit Main Station',
      html: `<input id="swal-edit-main" class="form-control text-center fs-5 fw-bold" value="${st.name}" placeholder="Main Station Name" style="text-transform: uppercase;">`,
      showCancelButton: true, confirmButtonText: 'Save',
      preConfirm: () => {
        const name = document.getElementById('swal-edit-main').value.trim().toUpperCase();
        if (!name) Swal.showValidationMessage('Name is required');
        return name;
      }
    }).then((res) => {
      if (res.isConfirmed) {
        currentRouting[index].name = res.value;
        renderMainStations(); saveCurrentRoutingToBackend();
      }
    });
  }

  function confirmDeleteMainStation(index, name) {
     swalModern.fire({ 
       title: `Delete ${name}?`, text: "All sub-stations inside will be deleted.", icon: 'warning', showCancelButton: true, confirmButtonText: 'Delete',
       customClass: { confirmButton: 'btn btn-danger px-4', cancelButton: 'btn btn-outline-secondary px-4' }
     }).then((res) => { if (res.isConfirmed) { currentRouting.splice(index, 1); renderMainStations(); saveCurrentRoutingToBackend(); } });
  }

  function openSubStations(index) {
    currentMainIndex = index;
    document.getElementById("display-main-station-name").textContent = currentRouting[index].name;
    document.getElementById("section-layout").classList.add("d-none");
    document.getElementById("section-sub-layout").classList.remove("d-none");
    renderSubStations();
  }

  function renderSubStations() {
    const container = document.getElementById("sub-station-container");
    container.innerHTML = "";
    
    let subs = currentRouting[currentMainIndex].subs || [];
    if (subs.length === 0) { container.innerHTML = `<div class="text-center text-muted py-4">No sub-stations configured here yet.</div>`; return; }
    
    subs.forEach((sub, subIndex) => {
      let mainName = currentRouting[currentMainIndex].name;
      let fullName = `${mainName} (${sub.name})`;
      let isSubCompleted = completedStations.includes(fullName);
      let statusClass = isSubCompleted ? "completed" : "manual";

      // [แก้ไข] เพิ่มเงื่อนไขตรวจสอบหน่วย Custom และเปลี่ยน Badge เป็น Batch: X pcs
      let unitBadge = "";
      if (sub.unit === 'Single') {
          unitBadge = '<span class="badge bg-secondary bg-opacity-10 text-secondary border border-secondary ms-1"><small>1-by-1 Piece</small></span>';
      } else if (sub.unit === 'Custom') {
          let divVal = sub.customDivisor || 1;
          unitBadge = `<span class="badge bg-primary bg-opacity-10 text-primary border border-primary ms-1"><small>Batch: ${divVal} pcs</small></span>`;
      } else {
          unitBadge = '<span class="badge bg-info bg-opacity-10 text-info border border-info ms-1"><small>Panel Flow</small></span>';
      }
      
      let actionHtml = "";
      if (isStaffMode) {
        actionHtml = `
          <button class="btn-icon edit shadow-sm" onclick="promptEditSubStation(${subIndex})" title="Edit"><i class="fa-solid fa-pen"></i></button>
          <button class="btn-icon enter d-flex align-items-center gap-2 shadow-sm" onclick="openTimeForm(${subIndex})"><i class="fa-solid fa-stopwatch"></i> Log Time</button>
          <button class="btn-icon del shadow-sm" onclick="confirmDeleteSubStation(${subIndex}, '${sub.name}')" title="Delete"><i class="fa-solid fa-trash-can"></i></button>
        `;
      } else {
         actionHtml = `<button class="btn-icon enter d-flex align-items-center gap-2 shadow-sm" onclick="openTimeForm(${subIndex})"><i class="fa-solid fa-stopwatch"></i> Log Time</button>`;
      }

      container.innerHTML += `
         <div class="station-item ${statusClass}" data-index="${subIndex}">
          ${isStaffMode ? '<div class="drag-handle" title="Drag to reorder"><i class="fa-solid fa-grip-vertical"></i></div>' : ''}
          <div class="station-seq">${subIndex + 1}</div>
          <div class="station-content">
            <h4 class="station-name">${sub.name}</h4>
            <div>${unitBadge}</div>
          </div>
          <div class="station-actions">${actionHtml}</div>
        </div>
      `;
     });

    if(subSortableInstance) subSortableInstance.destroy();
    if (isStaffMode) {
      subSortableInstance = new Sortable(container, {
        handle: '.drag-handle', animation: 200, ghostClass: 'bg-light',
        onEnd: function (evt) {
          let movedItem = currentRouting[currentMainIndex].subs.splice(evt.oldIndex, 1)[0];
          currentRouting[currentMainIndex].subs.splice(evt.newIndex, 0, movedItem);
          saveCurrentRoutingToBackend(); renderSubStations(); 
        }
      });
    }
  }

  function promptAddSubStation() { 
    swalModern.fire({
      title: 'Add Sub-Station',
      html: `<input id="swal-sub-name" class="form-control text-center fs-5 fw-bold" placeholder="Sub-Station Name (e.g. A, B, Line 1)" style="text-transform: uppercase;">
             <div class="mt-3 text-start px-3">
               <label class="fw-bold text-muted d-block mb-2 small text-uppercase">Workpiece Flow Type (CT Divisor):</label>
               <div class="form-check"><input class="form-check-input" type="radio" name="stUnit" value="Panel"> <label class="form-check-label text-info fw-bold">Panel Flow (Divide by Cavity)</label></div>
               <div class="form-check"><input class="form-check-input" type="radio" name="stUnit" value="Single" checked> <label class="form-check-label text-secondary fw-bold">Single Piece (Divide by 1)</label></div>
               <div class="form-check"><input class="form-check-input" type="radio" name="stUnit" value="Custom"> <label class="form-check-label text-primary fw-bold">Others (Custom Divisor)</label></div>
               <div class="mt-2 d-none" id="custom-divisor-container">
                 <input type="number" id="swal-custom-divisor" class="form-control form-control-sm border-primary text-center fw-bold text-primary" placeholder="Enter batch size (e.g. 5)" min="1" step="1">
               </div>
             </div>`,
      showCancelButton: true, confirmButtonText: 'Add',
      didOpen: () => {
        // [เพิ่มใหม่] Logic เปิด-ปิด ช่องกรอกตัวเลขเมื่อเลือก Others
        const radios = document.querySelectorAll('input[name="stUnit"]');
        const container = document.getElementById('custom-divisor-container');
        radios.forEach(r => r.addEventListener('change', (e) => {
          if (e.target.value === 'Custom') container.classList.remove('d-none');
          else container.classList.add('d-none');
        }));
      },
      preConfirm: () => {
        const name = document.getElementById('swal-sub-name').value.trim().toUpperCase();
        if (!name) return Swal.showValidationMessage('Sub-Station name is required');
        
        const unitVal = document.querySelector('input[name="stUnit"]:checked').value;
        let customVal = null;
        
        // [เพิ่มใหม่] Validation ตรวจสอบให้กรอกเฉพาะจำนวนเต็มบวก
        if (unitVal === 'Custom') {
          customVal = parseInt(document.getElementById('swal-custom-divisor').value);
          if (isNaN(customVal) || customVal < 1) {
            Swal.showValidationMessage('Please enter a valid positive integer for Custom Divisor (e.g. 5)');
            return false;
          }
        }
        return { name: name, unit: unitVal, customDivisor: customVal };
       }
    }).then((res) => { 
      if (res.isConfirmed) { 
        if(!currentRouting[currentMainIndex].subs) currentRouting[currentMainIndex].subs = [];
        // [แก้ไข] Push ค่า customDivisor แนบไปด้วย
        currentRouting[currentMainIndex].subs.push({name: res.value.name, unit: res.value.unit, customDivisor: res.value.customDivisor}); 
        renderSubStations(); saveCurrentRoutingToBackend(); 
      } 
    });
  }

  function promptEditSubStation(subIndex) {
    let sub = currentRouting[currentMainIndex].subs[subIndex];
    let isCustom = (sub.unit === 'Custom');
    let customVal = sub.customDivisor || "";
    
    swalModern.fire({
      title: 'Edit Sub-Station',
      html: `<input id="swal-edit-sub" class="form-control text-center fs-5 fw-bold" value="${sub.name}" placeholder="Sub-Station Name" style="text-transform: uppercase;">
             <div class="mt-3 text-start px-3">
               <label class="fw-bold text-muted d-block mb-2 small text-uppercase">Workpiece Flow Type (CT Divisor):</label>
               <div class="form-check"><input class="form-check-input" type="radio" name="editStUnit" value="Panel" ${sub.unit === 'Panel' ? 'checked' : ''}> <label class="form-check-label text-info fw-bold">Panel Flow (Divide by Cavity)</label></div>
               <div class="form-check"><input class="form-check-input" type="radio" name="editStUnit" value="Single" ${sub.unit === 'Single' ? 'checked' : ''}> <label class="form-check-label text-secondary fw-bold">Single Piece (Divide by 1)</label></div>
               <div class="form-check"><input class="form-check-input" type="radio" name="editStUnit" value="Custom" ${isCustom ? 'checked' : ''}> <label class="form-check-label text-primary fw-bold">Others (Custom Divisor)</label></div>
               <div class="mt-2 ${isCustom ? '' : 'd-none'}" id="edit-custom-divisor-container">
                 <input type="number" id="swal-edit-custom-divisor" class="form-control form-control-sm border-primary text-center fw-bold text-primary" placeholder="Enter batch size (e.g. 5)" min="1" step="1" value="${customVal}">
               </div>
             </div>`,
      showCancelButton: true, confirmButtonText: 'Save',
      didOpen: () => {
        // [เพิ่มใหม่] Logic เปิด-ปิด ช่องกรอกตัวเลขในโหมดแก้ไข
        const radios = document.querySelectorAll('input[name="editStUnit"]');
        const container = document.getElementById('edit-custom-divisor-container');
        radios.forEach(r => r.addEventListener('change', (e) => {
          if (e.target.value === 'Custom') container.classList.remove('d-none');
          else container.classList.add('d-none');
        }));
      },
      preConfirm: () => {
        const name = document.getElementById('swal-edit-sub').value.trim().toUpperCase();
        if (!name) return Swal.showValidationMessage('Sub-Station name is required');
        
        const unitVal = document.querySelector('input[name="editStUnit"]:checked').value;
        let customVal = null;
        
        if (unitVal === 'Custom') {
          customVal = parseInt(document.getElementById('swal-edit-custom-divisor').value);
          if (isNaN(customVal) || customVal < 1) {
            Swal.showValidationMessage('Please enter a valid positive integer for Custom Divisor (e.g. 5)');
            return false;
          }
        }
        return { name: name, unit: unitVal, customDivisor: customVal };
       }
    }).then((res) => { 
      if (res.isConfirmed) { 
        currentRouting[currentMainIndex].subs[subIndex] = res.value; 
        renderSubStations(); saveCurrentRoutingToBackend(); swalModern.fire({ icon: 'success', title: 'Updated', timer: 1000, showConfirmButton: false }); 
      } 
    });
  }

  function confirmDeleteSubStation(subIndex, subName) {
     swalModern.fire({ 
       title: `Delete ${subName}?`, icon: 'warning', showCancelButton: true, confirmButtonText: 'Delete',
       customClass: { confirmButton: 'btn btn-danger px-4', cancelButton: 'btn btn-outline-secondary px-4' }
     }).then((res) => { if (res.isConfirmed) { currentRouting[currentMainIndex].subs.splice(subIndex, 1); renderSubStations(); saveCurrentRoutingToBackend(); } });
  }

  function saveCurrentRoutingToBackend() { 
     allModelRoutings[currentModel] = currentRouting; 
     google.script.run.withFailureHandler(console.error).updateModelConfig(currentLine, currentModel, currentCavity, currentRouting);
  }

  let currentStationLine = "-"; 

  function openTimeForm(subIndex) { 
    let mainStation = currentRouting[currentMainIndex];
    let sub = mainStation.subs[subIndex];
    
    // ดึงรายการ Line ที่รองรับ
    let supportedLines = [];
    if (mainStation.lines) {
      supportedLines = mainStation.lines.split(/[,&]+/).map(l => l.trim()).filter(l => l !== "");
    }

    // ฟังก์ชันย่อยสำหรับเข้าหน้า Form
    const proceedToForm = (selectedLine) => {
        currentStationLine = selectedLine.toUpperCase();
        
        let displayName = `${mainStation.name} (${sub.name})`;
        currentStation = displayName; 
        let unit = sub.unit;
        currentRound = 1; 
        
        if (unit === 'Single') currentEffCavity = 1;
        else if (unit === 'Custom') currentEffCavity = parseInt(sub.customDivisor) || 1;
        else currentEffCavity = currentCavity;
        
        document.getElementById("display-station").textContent = currentStation;
        document.getElementById("display-line-form").textContent = currentStationLine; 
        document.getElementById("display-model-form").textContent = currentModel; 
        document.getElementById("display-cavity").textContent = currentEffCavity; 
        
        generateCycleTable();
        resetStopwatch();
        loadDraftCache(); 
        checkPullButtonVisibility(); 
        
        document.getElementById("section-sub-layout").classList.add("d-none"); 
        document.getElementById("section-form").classList.remove("d-none");
    };

    // [Logic เด้ง Popup ถาม Line พร้อม UI แบบ iPad-Friendly]
    if (supportedLines.length > 0) {
        // [แก้ไข UI] เปลี่ยนเป็น d-grid และปุ่ม btn-outline-primary ขนาดใหญ่
        let optionsHtml = '<div class="d-grid gap-3 mt-3 px-2">'; 
        supportedLines.forEach(l => {
            optionsHtml += `
              <input type="radio" class="btn-check" name="swalLineSelect" id="line_${l}" value="${l}">
              <label class="btn btn-outline-primary fw-bold fs-4 py-3 rounded-4 shadow-sm" for="line_${l}">${l}</label>
            `;
        });
        optionsHtml += '</div>';
        
        swalModern.fire({
            title: 'Select Production Line',
            html: `<p class="text-muted small mb-2">กรุณาระบุไลน์การผลิตสำหรับ ${mainStation.name}</p>` + optionsHtml,
            showCancelButton: true, confirmButtonText: 'Confirm',
            preConfirm: () => {
                let selected = document.querySelector('input[name="swalLineSelect"]:checked');
                if (!selected) return Swal.showValidationMessage('กรุณาเลือก Line ก่อนเริ่มจับเวลา!');
                return selected.value;
            }
        }).then((res) => {
            if (res.isConfirmed) proceedToForm(res.value);
        });
    } else {
        // Fallback กรณีไม่มี Data เก่า (ให้พิมพ์เอง)
        swalModern.fire({
            title: 'Enter Production Line',
            input: 'text',
            inputPlaceholder: 'e.g. A1, B2',
            showCancelButton: true, confirmButtonText: 'Confirm',
            preConfirm: (val) => {
                if (!val.trim()) return Swal.showValidationMessage('กรุณาระบุ Line ก่อนเริ่มจับเวลา!');
                return val.trim();
            }
        }).then((res) => {
            if (res.isConfirmed) proceedToForm(res.value);
        });
    }
  }

  // [เพิ่มใหม่] ให้ผู้ใช้กดปุ่ม Edit บนมุมซ้ายของฟอร์มเพื่อแก้ Line ได้
  function promptEditCurrentLine() {
      let mainStation = currentRouting[currentMainIndex];
      let supportedLines = [];
      if (mainStation && mainStation.lines) {
        supportedLines = mainStation.lines.split(/[,&]+/).map(l => l.trim()).filter(l => l !== "");
      }

      if (supportedLines.length > 0) {
          // มีข้อมูล Master Data -> โชว์ปุ่มขนาดใหญ่ให้เลือกใหม่ (iPad-friendly)
          let optionsHtml = '<div class="d-grid gap-3 mt-3 px-2">'; 
          supportedLines.forEach(l => {
              // [เพิ่ม Logic] ติ๊กค่าปัจจุบันให้เป็น Default
              let isChecked = (l.toUpperCase() === currentStationLine) ? "checked" : "";
              optionsHtml += `
                <input type="radio" class="btn-check" name="swalLineSelectEdit" id="edit_line_${l}" value="${l}" ${isChecked}>
                <label class="btn btn-outline-primary fw-bold fs-4 py-3 rounded-4 shadow-sm" for="edit_line_${l}">${l}</label>
              `;
          });
          optionsHtml += '</div>';

          swalModern.fire({
              title: 'Edit Current Line',
              html: `<p class="text-muted small mb-2">เลือกไลน์การผลิตที่ต้องการเปลี่ยน</p>` + optionsHtml,
              showCancelButton: true, confirmButtonText: 'Update',
              preConfirm: () => {
                  let selected = document.querySelector('input[name="swalLineSelectEdit"]:checked');
                  if (!selected) return Swal.showValidationMessage('กรุณาเลือก Line!');
                  return selected.value;
              }
          }).then((res) => {
              if (res.isConfirmed) {
                  currentStationLine = res.value.toUpperCase();
                  document.getElementById("display-line-form").textContent = currentStationLine;
                  saveDraftCache();
              }
          });
      } else {
          // ไม่มี Master Data -> Fallback เป็นพิมพ์ Text
          swalModern.fire({
              title: 'Edit Current Line',
              input: 'text',
              inputValue: currentStationLine, // เติมค่าเก่าไว้ให้
              inputPlaceholder: 'e.g. A1, B2',
              showCancelButton: true, confirmButtonText: 'Update',
              preConfirm: (val) => {
                  if (!val.trim()) return Swal.showValidationMessage('Line cannot be empty');
                  return val.trim();
              }
          }).then((res) => {
              if (res.isConfirmed) {
                  currentStationLine = res.value.toUpperCase();
                  document.getElementById("display-line-form").textContent = currentStationLine;
                  saveDraftCache();
              }
          });
      }
  }

  function generateCycleTable() { 
    let html = "";
    for (let i = 1; i <= 10; i++) {
      html += `<tr><td class="text-center fw-bold text-muted">${i}</td><td>
          <input type="number" id="cycletime-${i}" oninput="calculateAvg(); saveDraftCache();" min="0" step="0.01" class="form-control text-center fs-6 text-primary fw-bold">
          </td>`;
      html += `<td><input type="text" id="remark-${i}" oninput="saveDraftCache()" class="form-control form-control-sm bg-light border-0 rounded-pill px-3"></td></tr>`;
    }
    document.getElementById("cycle-table-body").innerHTML = html;
    calculateAvg();
  }

  function calculateAvg() { 
    let times = [];
    for (let i = 1; i <= 10; i++) {
      let el = document.getElementById(`cycletime-${i}`);
      if (el) {
        let ct = parseFloat(el.value);
        if (!isNaN(ct) && ct > 0) { 
          times.push(ct);
        }
      }
    }
    
    let count = times.length;
    let avgCt = 0;
    
    if (count > 0) {
      if (count >= 3) {
        // [Defensive] กรณีข้อมูล >= 3 ตัด Min/Max ออกเพื่อหาค่าเสถียรที่สุด
        times.sort((a, b) => a - b);
        let trimmedTimes = times.slice(1, -1);
        let totalTime = trimmedTimes.reduce((sum, val) => sum + val, 0);
        avgCt = totalTime / trimmedTimes.length;
      } else {
        // [Defensive] กรณีข้อมูล < 3 ให้ใช้ค่าเฉลี่ยปกติ
        let totalTime = times.reduce((sum, val) => sum + val, 0);
        avgCt = totalTime / count;
      }
    }
    
    document.getElementById("total-cycle").textContent = (avgCt / currentEffCavity).toFixed(2);
  }

  function submitData() {
    // [เพิ่มใหม่] 2. ตรวจสอบว่ากรอกชื่อครบหรือไม่ (Validation)
    let opName = document.getElementById("operator-name").value.trim();
    let chkName = document.getElementById("checker-name").value.trim();
    if (!opName || !chkName) {
      return swalModern.fire('Validation Error', 'Please enter both Operator and Checker names.', 'warning');
    }

    let btn = document.getElementById("btn-submit");
    btn.disabled = true; 
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin me-2"></i>Submitting...`;
    
    let payload = { 
      line: currentStationLine, 
      model: currentModel, 
      station: currentStation, 
      cavity: currentEffCavity, 
      sessionTag: currentSessionTag, 
      routing: currentRouting, 
      cycles: [],
      totalCycle: document.getElementById("total-cycle").textContent,
      // [เพิ่มใหม่] ส่งชื่อ 2 คนไปให้ Backend
      operator: opName,
      checker: chkName
    };

    // ... (ส่วนการวนลูป 10 รอบ และ google.script.run ปล่อยไว้เหมือนเดิมครับ) ...
    for (let i = 1; i <= 10; i++) { 
      payload.cycles.push({ 
        cycleTime: document.getElementById(`cycletime-${i}`).value, 
        remark: document.getElementById(`remark-${i}`).value || ""
      });
    }
    
    google.script.run
      .withSuccessHandler((res) => { 
        btn.disabled = false; 
        btn.innerHTML = `<i class="fa-solid fa-cloud-arrow-up me-2"></i> Submit to Database`; 
        if(res.success) { 
          clearDraftCache(); 
          currentRound = 1;  
          if (!completedStations.includes(currentStation)) {
            completedStations.push(currentStation);
          }
          swalModern.fire({ icon: 'success', title: 'Saved successfully', timer: 1500, showConfirmButton: false }); 
          backToSubLayout(); 
        } else { 
          swalModern.fire('Error', res.message, 'error'); 
        }
      })
      .withFailureHandler((err) => {
        btn.disabled = false; 
        btn.innerHTML = `<i class="fa-solid fa-cloud-arrow-up me-2"></i> Submit to Database`;
        swalModern.fire('Error', err.message, 'error');
      })
      .saveTimeStudyDataFlat(payload);
  }

  function backToSubLayout() { 
    currentRound = 1; 
    renderSubStations(); 
    document.getElementById("section-form").classList.add("d-none"); 
    document.getElementById("section-sub-layout").classList.remove("d-none"); 
  }

  function toggleStopwatch() { 
    const btn = document.getElementById("btn-stopwatch-toggle");
    
    if (!isStopwatchRunning) { 
      isStopwatchRunning = true; 
      stopwatchStartTime = performance.now(); 
      lastLapTime = stopwatchStartTime;
      updateStopwatchDisplay(); 
      
      btn.innerHTML = `<i class="fa-solid fa-flag-checkered me-2"></i> Record Round ${currentRound}`; 
      btn.className = "btn btn-warning text-white fw-bold px-4 py-3 btn-lg me-2 shadow-sm"; 
    } 
    else { 
      if (currentRound <= 10) {
        let now = performance.now();
        let lapTime = (now - lastLapTime) / 1000; 
        
        document.getElementById(`cycletime-${currentRound}`).value = lapTime.toFixed(2);
        calculateAvg();
        saveDraftCache(); 
        
        lastLapTime = now;
        currentRound++;
        
        if (currentRound <= 10) {
          btn.innerHTML = `<i class="fa-solid fa-flag-checkered me-2"></i> Record Round ${currentRound}`;
        } else {
          isStopwatchRunning = false;
          cancelAnimationFrame(stopwatchAnimationFrame);
          btn.innerHTML = `<i class="fa-solid fa-stop me-2"></i> Finished`;
          btn.className = "btn btn-danger text-white fw-bold px-4 py-3 btn-lg me-2 shadow-sm";
          btn.disabled = true;
        }
      }
    }
  }
  
  function updateStopwatchDisplay() { 
    if (!isStopwatchRunning) return;
    let currentElapsed = performance.now() - stopwatchStartTime;
    document.getElementById("stopwatch-display").textContent = (currentElapsed / 1000).toFixed(2);
    stopwatchAnimationFrame = requestAnimationFrame(updateStopwatchDisplay);
  }

  function resetStopwatch() { 
    isStopwatchRunning = false; 
    cancelAnimationFrame(stopwatchAnimationFrame); 
    stopwatchStartTime = 0; 
    lastLapTime = 0;
    document.getElementById("stopwatch-display").textContent = "0.00";
    
    const btn = document.getElementById("btn-stopwatch-toggle");
    if (btn) { 
      if (currentRound <= 10) {
        btn.innerHTML = `<i class="fa-solid fa-play me-2"></i> Start Round ${currentRound}`; 
        btn.className = "btn btn-primary fw-bold px-4 py-3 btn-lg me-2 shadow-sm"; 
        btn.disabled = false;
      } else {
        btn.innerHTML = `<i class="fa-solid fa-stop me-2"></i> Finished`;
        btn.className = "btn btn-danger text-white fw-bold px-4 py-3 btn-lg me-2 shadow-sm";
        btn.disabled = true;
      }
    }
  }

  function backToSelect() { 
    document.getElementById('session-name').value = '';
    $('#existing-session-select').val('').trigger('change');

    let savedModel = $('#model-select').val();
    google.script.run
      .withSuccessHandler(function(res) {
          allModelSessions = res.modelSessionMap || {};
          if (savedModel && allModelSessions[savedModel]) {
            let existingSelect = $('#existing-session-select');
            existingSelect.empty();
            existingSelect.append(new Option("✨ Create New Version (Use settings below)", ""));
            // [แก้ไข] จำกัดการแสดงผลเฉพาะ 5 Session ล่าสุด
            let sessions = [...allModelSessions[savedModel]].reverse().slice(0, 5);
            sessions.forEach(tag => {
              existingSelect.append(new Option(`🔄 Continue: ${tag}`, tag));
            });
          }
        })
      .getInitialConfig();

    document.getElementById("section-layout").classList.add("d-none"); 
    document.getElementById("section-select").classList.remove("d-none"); 
  }

  // ==========================================================================
  // [ส่วนของ Dashboard] ฟังก์ชันระบบแดชบอร์ดและการส่งออกข้อมูล
  // ==========================================================================
  
  function openDashboardFromMatrix(model, sessionTag) {
      try {
        currentLine = "-";
        currentModel = String(model || ""); 
        currentDashboardCavity = allModelCavities[currentModel] || 1;
        isNavigatedFromMatrix = true;

        document.getElementById("section-matrix").classList.add("d-none");
        document.getElementById("section-dashboard").classList.remove("d-none");
        document.getElementById("db-model-title").textContent = currentModel;
        document.getElementById("dashboard-table-body").innerHTML = `<tr><td colspan="3" class="text-center py-5 text-muted"><div class="spinner-border text-primary mb-2" role="status"></div><br>Loading Dashboard...</td></tr>`;
        
        // [แก้ไข] เปลี่ยนจาก String เป็น Array [...] เพื่อให้ Backend รองรับ Multi-select ได้ถูกต้อง
        let targetTags = sessionTag ? [String(sessionTag)] : [];
        loadDashboardData(targetTags, currentActiveArchiveId);
      } catch(e) { alert("System Error: " + e.message); }
  }

  function loadDashboardData(targetSessionTags = [], archiveId = "ACTIVE", targetLine = "ALL") {
      let safeModel = String(currentModel || "");
      
      google.script.run.withSuccessHandler((response) => { 
            
            // --- [ส่วนที่เพิ่มใหม่: จัดเรียงลำดับตาม Master] ---
            let rawData = response.data || []; 
            let routing = allModelRoutings[currentModel] || [];
            let sortOrder = [];
            
            routing.forEach(main => {
               if (main.subs && main.subs.length > 0) {
                  main.subs.forEach(sub => sortOrder.push(`${main.name} (${sub.name})`));
               } else {
                  sortOrder.push(main.name);
               }
            });

            rawData.sort((a, b) => {
                let nameA = `${a.mainStation} (${a.subStation})`;
                let nameB = `${b.mainStation} (${b.subStation})`;
                let indexA = sortOrder.indexOf(nameA);
                let indexB = sortOrder.indexOf(nameB);
                if (indexA === -1) indexA = 999; 
                if (indexB === -1) indexB = 999;
                return indexA - indexB;
            });
            
            currentDashboardData = rawData; 
            // ---------------------------------------------
            
            // 1. จัดการ Dropdown Line
            const $lineSelect =$('#dashboard-line-select');
            let currentLineVal = targetLine;
            $lineSelect.empty().append(new Option("All Lines", "ALL"));
            (response.availableLines || []).forEach(line => {
                $lineSelect.append(new Option(line, line));
            });
            $lineSelect.val(currentLineVal);

            // 2. จัดการ Dropdown Session (Multi-select Select2)
            const $sessionSelect = $('#dashboard-session-select');
            if ($sessionSelect.hasClass("select2-hidden-accessible")) {
                $sessionSelect.select2('destroy');
            }
            $sessionSelect.empty();
            
            let availSessions = response.availableSheets || [];
            if (availSessions.length > 0) {
              availSessions.forEach(sheetName => {
                 $sessionSelect.append(new Option(sheetName, sheetName));
              });
            }
            
            $sessionSelect.select2({
              theme: 'bootstrap-5', 
              width: '500px', // ✅ กำหนดเป็น 500px หรือถ้าอยากยาวกว่านี้ใส่ 600px, 700px ได้เลยครับ
              placeholder: 'Select Sessions to Aggregate', 
              allowClear: true
            });
            
            if (response.activeSessions && response.activeSessions.length > 0) {
               $sessionSelect.val(response.activeSessions).trigger('change.select2');
            }

            $sessionSelect.off('select2:select select2:unselect').on('select2:select select2:unselect', function(e) {
               setTimeout(() => changeDashboardFilter(), 50);
            });

            // [แก้ไข 4] ลบการอัปเดต #dashboard-date-select ที่ลบทิ้งไปแล้วออกไป

            // 3. วาดตารางและกราฟ
            renderWebDashboard(currentDashboardData, response.lastUpdated, response.panelCavity);
            
      }).getDashboardData(safeModel, targetLine, targetSessionTags, archiveId);
  }

  function changeDashboardFilter() {
      let selectedSessions = $('#dashboard-session-select').val() || [];
      let selectedLine = $('#dashboard-line-select').val() || "ALL";
      
      document.getElementById("dashboard-table-body").innerHTML = `<tr><td colspan="10" class="text-center py-5 text-muted"><div class="spinner-border text-primary mb-2" role="status"></div><br>Aggregating Global Average...</td></tr>`;
      
      // เรียกข้อมูลใหม่ โดยส่ง Array ของ Session และ Line กลับไปให้ Backend คำนวณ
      loadDashboardData(selectedSessions, currentActiveArchiveId, selectedLine);
  }

  function updateInsightsMetrics(data) {
    const metricsDiv = document.getElementById("insight-metrics");
    if(!data || data.length === 0) { metricsDiv.classList.add("d-none"); return; }
    metricsDiv.classList.remove("d-none");

    let baseMaxCT = Math.max(...data.map(i => i.total));
    let baseBNObj = data.find(i => i.total === baseMaxCT);
    let baseBN = baseBNObj ? `${baseBNObj.mainStation} (${baseBNObj.subStation})` : "-";
    let baseUPH = baseMaxCT > 0 ? Math.floor(3600 / baseMaxCT) : 0;
    
    // การคำนวณตามหลักการของ Excel Template
    let headCount = data.length; // 1 Sub-station = 1 Process
    let lineTotalTime = baseMaxCT * headCount; // Capacity สูงสุดอิงจากคอขวด
    
    let totalLossTime = 0; // หาเวลาว่างของแต่ละ Process
    data.forEach(item => {
      totalLossTime += (baseMaxCT - item.total);
    });
    
    // การหา Line Efficiency %
    let lineEfficiency = lineTotalTime > 0 ? (1 - (totalLossTime / lineTotalTime)) * 100 : 0;
    
    // การหา Capacity Estimate โดยอิงจากชั่วโมงการทำงาน
    let taktHoursInput = parseFloat(document.getElementById('takt-hours').value);
    let workingHours = (isNaN(taktHoursInput) || taktHoursInput <= 0) ? 7 : taktHoursInput; // Default 7 ชั่วโมง
    let capacityEst = baseMaxCT > 0 ? Math.floor((workingHours * 3600) / baseMaxCT) : 0;

    // อัปเดตผลลัพธ์ลง DOM
    document.getElementById("uph-base").textContent = baseUPH;
    document.getElementById("bn-base").textContent = baseBN + ` (${baseMaxCT.toFixed(2)}s)`;
    document.getElementById("cap-base").textContent = capacityEst.toLocaleString(); // ใส่คอมม่าคั่นหลักพัน
    document.getElementById("loss-base").textContent = totalLossTime.toFixed(2);
    
    // จัดการ Progress Bar ของ Line Efficiency และเปลี่ยนสีตามความสมดุล
    let effEl = document.getElementById("eff-progress");
    if(effEl) {
       let displayEff = lineEfficiency.toFixed(1);
       effEl.style.width = `${displayEff}%`;
       effEl.textContent = `${displayEff}%`;
       effEl.setAttribute("aria-valuenow", displayEff);
       
       effEl.className = "progress-bar fw-bold fs-6";
       if (lineEfficiency >= 85) effEl.classList.add("bg-success");
       else if (lineEfficiency >= 70) effEl.classList.add("bg-info");
       else if (lineEfficiency >= 50) effEl.classList.add("bg-warning", "text-dark");
       else effEl.classList.add("bg-danger");
    }
  }

  function renderWebDashboard(data, lastUpdated, panelCavity) {
    const tbody = document.getElementById("dashboard-table-body");
    let html = "";
    
    // อัปเดตการ์ดตัวเลขสรุปด้านบน
    updateInsightsMetrics(data);

    // วาดตารางข้อมูล
    data.forEach(item => { 
      html += `<tr>
          <td class="fw-bold text-main bg-light border-0 rounded-start text-start ps-4">${item.mainStation}</td>
          <td class="fw-bold text-muted bg-light border-0 text-start">${item.subStation}</td>
          <td class="fw-bold text-primary bg-primary bg-opacity-10 border-0 rounded-end">${item.total.toFixed(2)}</td>
        </tr>
        <tr><td colspan="3" class="p-1 border-0"></td></tr>`;
    });

    if(lastUpdated !== "-") {
      html += `
        <tr class="table-light">
          <td colspan="2" class="text-start text-muted px-4 py-3 border-0 rounded-start-3"><i class="fa-regular fa-clock me-2"></i> <strong>Last Updated:</strong> ${lastUpdated}</td>
          <td colspan="1" class="text-end text-muted px-4 py-3 border-0 rounded-end-3"><strong>Workpiece Form:</strong> ${panelCavity}</td>
        </tr>
      `;
    }
    tbody.innerHTML = html;
    
    // วาดกราฟแท่ง (Bar Chart)
    let chartDatasets = [];
    const maxTotal = data.length > 0 ? Math.max(...data.map(i => i.total)) : 0;
    const bgColors = data.map(i => i.total === maxTotal && i.total > 0 ? '#ef4444' : '#2563eb');
    chartDatasets.push({ type: 'bar', label: 'Cycle Time', data: data.map(i => i.total), backgroundColor: bgColors, borderRadius: 8 });

    const ctx = document.getElementById('localSummaryChart').getContext('2d');
    if (webChartInstance) webChartInstance.destroy();
    
    Chart.defaults.font.family = "'Inter', sans-serif";
    Chart.defaults.color = '#64748b';
    webChartInstance = new Chart(ctx, { 
      type: 'bar', 
      data: { labels: data.map(i => `${i.mainStation} (${i.subStation})`), datasets: chartDatasets }, 
      options: { 
        responsive: true, maintainAspectRatio: false,
        animation: { duration: 1000, easing: 'easeOutBack' },
        plugins: { legend: { display: true, position: 'bottom', labels: { usePointStyle: true, padding: 20 } } }, 
        scales: { 
          y: { beginAtZero: true, grid: { borderDash: [4, 4], color: '#e2e8f0' } },
          x: { grid: { display: false } }
        } 
      } 
    });
    updateChartTaktTime();
  }

  async function downloadExcelStream(url, payload, defaultFilename) {
    swalModern.fire({
      title: 'Generating Excel File...',
      text: 'Creating .xlsx file from server. Please wait.',
      allowOutsideClick: false,
      didOpen: () => Swal.showLoading()
    });
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!res.ok) throw new Error('Failed to generate Excel file');
      
      // แปลงข้อมูล Binary Stream ที่ได้จาก Server เป็นไฟล์เพื่อดาวน์โหลด
      const blob = await res.blob();
      const downloadUrl = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = downloadUrl;
      link.download = defaultFilename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(downloadUrl); // คืน RAM ให้ Browser ทันที
      swalModern.close();
    } catch (err) {
      swalModern.fire('Error', err.message, 'error');
    }
  }

  function exportToExcel() {
    if (currentDashboardData.length === 0) return swalModern.fire('Notice', 'No data to export.', 'warning');
    let activeLineForExport = $('#dashboard-line-select').val() || "ALL";
    downloadExcelStream(
      '/api/export/dashboard',
      { data: currentDashboardData, model: currentModel, line: activeLineForExport, taktTime: currentTaktTime },
      `TimeStudy_${currentModel}_${activeLineForExport}_${Date.now()}.xlsx`
    );
  }

  let currentTaktTime = 0;

  function calculateTaktTime() {
    let forecast = parseFloat(document.getElementById('takt-forecast').value);
    let days = parseFloat(document.getElementById('takt-days').value);
    let hours = parseFloat(document.getElementById('takt-hours').value);

    if (forecast > 0 && days > 0 && hours > 0) {
      let totalSeconds = days * hours * 3600;
      currentTaktTime = totalSeconds / forecast;
      document.getElementById('display-takt-time').textContent = currentTaktTime.toFixed(2);
    } else {
      currentTaktTime = 0;
      document.getElementById('display-takt-time').textContent = "-";
    }
    
    updateChartTaktTime();
    // [เพิ่มใหม่] เพื่อให้เวลาผู้ใช้ปรับเปลี่ยนช่อง Working Hours ค่า Capacity จะอัปเดตแบบ Realtime
    updateInsightsMetrics(currentDashboardData); 
  }

  function updateChartTaktTime() {
    if (!webChartInstance || currentDashboardData.length === 0) return;
    
    let hasTaktLine = webChartInstance.data.datasets.length > 1;
    
    if (currentTaktTime > 0) {
      let taktDataArray = currentDashboardData.map(() => currentTaktTime);
      
      if (hasTaktLine) {
        webChartInstance.data.datasets[1].data = taktDataArray;
        webChartInstance.data.datasets[1].label = `Takt Time (${currentTaktTime.toFixed(2)}s)`;
      } else {
        webChartInstance.data.datasets.push({
          type: 'line',
          label: `Takt Time (${currentTaktTime.toFixed(2)}s)`,
          data: taktDataArray,
          borderColor: '#f59e0b',
          borderWidth: 2,
          borderDash: [5, 5],
          pointRadius: 0,
          fill: false
        });
      }
    } else {
      if (hasTaktLine) webChartInstance.data.datasets.pop();
    }
    webChartInstance.update();
  }

  // ==========================================================================
  // [ส่วนของ Summary Matrix] ระบบการจัดการหน้า Summary Matrix
  // ==========================================================================
  
  let globalMatrixData = []; 
  let currentFilteredMatrixData = []; // [เพิ่มใหม่] ตัวแปรเก็บข้อมูลที่ถูก Filter แล้ว เพื่อนำไป Export

  // [เพิ่มใหม่] ตัวแปรเก็บ Archive ID ที่กำลังเลือก
  let currentActiveArchiveId = "ACTIVE"; 

  // [แก้ไข] ฟังก์ชันเรียกหน้า Summary Matrix
  function openMatrixSummary() {
    try {
      document.getElementById("section-select").classList.add("d-none");
      document.getElementById("section-matrix").classList.remove("d-none");
      fetchMatrixData();
    } catch (e) { console.error(e); }
  }

  function fetchMatrixData() {
      const container = document.getElementById("matrixAccordion");
      container.innerHTML = `<div class="text-center py-5 text-muted bg-white rounded-4 border"><div class="spinner-border text-info mb-2" role="status"></div><br>Fetching Database...</div>`;
      
      google.script.run.withSuccessHandler(function(res) {
          if (res.success) {
            globalMatrixData = res.data;
            currentFilteredMatrixData = [...globalMatrixData]; 
            populateMatrixFilters(); 
            renderMatrixTable(globalMatrixData); 
          } else {
            container.innerHTML = `<div class="text-center py-4 text-danger bg-white rounded-4 border">Error: ${res.message}</div>`;
          }
      }).getAllMatrixSummaryData();
  }


  function populateMatrixFilters() {
    // 1. ทำลาย Select2 เดิมทิ้งก่อน (ป้องกัน UI ซ้อนกัน)
    if ($('#filter-model').hasClass("select2-hidden-accessible")) $('#filter-model').select2('destroy');
    if ($('#filter-session').hasClass("select2-hidden-accessible")) $('#filter-session').select2('destroy');
    if ($('#filter-date').hasClass("select2-hidden-accessible")) $('#filter-date').select2('destroy');
    if ($('#filter-line').hasClass("select2-hidden-accessible")) $('#filter-line').select2('destroy'); 

    // 2. ล้างตัวเลือก (Options) เก่าออกทั้งหมด
    $('#filter-model, #filter-session, #filter-date, #filter-line').empty();

    // 3. เริ่มต้น Select2 ใหม่ พร้อมตั้งค่า Placeholder
    $('#filter-model').select2({ theme: 'bootstrap-5', width: '100%', placeholder: 'All Models', allowClear: true });
    $('#filter-session').select2({ theme: 'bootstrap-5', width: '100%', placeholder: 'All Sessions', allowClear: true });
    $('#filter-date').select2({ theme: 'bootstrap-5', width: '100%', placeholder: 'All Months', allowClear: true });
    $('#filter-line').select2({ theme: 'bootstrap-5', width: '100%', placeholder: 'All Lines', allowClear: true });

    // 4. ผูก Event Listener เฉพาะตอนที่ผู้ใช้กดเลือก (select) หรือยกเลิก (unselect) เพื่อป้องกัน Infinite Loop
    $('#filter-model, #filter-session, #filter-date, #filter-line').off('select2:select select2:unselect').on('select2:select select2:unselect', function(e) {
      setTimeout(() => {
        applyMatrixFilters();
      }, 50);
    });

    // 5. สั่งรัน Filter ทันทีเพื่อสร้างตัวเลือกทั้งหมด (Initial Data Load)
    applyMatrixFilters();
  }

  function applyMatrixFilters() {
    try {
      // ดึงค่า Array ปัจจุบันที่ผู้ใช้เลือกไว้
      let selModels = $('#filter-model').val() || [];
      let selSessions = $('#filter-session').val() || [];
      let selMonths = $('#filter-date').val() || [];
      let selLines = $('#filter-line').val() || []; 

      // ฟังก์ชันช่วยแยก "เดือน-ปี" ออกจาก Timestamp
      const getMonthString = (ts) => {
          if (!ts) return null;
          let parts = ts.split(' ')[0].split('-');
          return parts.length === 3 ? parts[1] + "-" + parts[2] : null;
      };

      // ---------------------------------------------------------
      // ฟังก์ชันย่อยสำหรับกรองข้อมูลแบบ Cross-Filtering
      // โดยสามารถ "ข้าม (Skip)" การกรองของตัวเองได้ เพื่อหาว่ามีตัวเลือกอะไรเหลือให้เลือกบ้าง
      // ---------------------------------------------------------
      const filterData = (skipCategory) => {
          let validSessionsByLine = new Set();
          
          // Logic เดิม: Session-Level Filter สำหรับ Line
          if (skipCategory !== 'Line' && selLines.length > 0) {
             globalMatrixData.forEach(r => {
                if (selLines.includes(r.line)) validSessionsByLine.add(r.model + "___" + r.session);
             });
          }

          return globalMatrixData.filter(r => {
              let passModel = (skipCategory === 'Model') || (selModels.length === 0 || selModels.includes(r.model));
              let passSession = (skipCategory === 'Session') || (selSessions.length === 0 || selSessions.includes(r.session));
              
              let passMonth = true;
              if (skipCategory !== 'Month' && selMonths.length > 0) {
                  let rMonth = getMonthString(r.timestamp);
                  passMonth = rMonth && selMonths.includes(rMonth);
              }
              
              let passLine = true;
              if (skipCategory !== 'Line' && selLines.length > 0) {
                  passLine = validSessionsByLine.has(r.model + "___" + r.session);
              }
              
              return passModel && passSession && passMonth && passLine;
          });
      };

      // 1. ดึงข้อมูลที่ผ่านฟิลเตอร์ "ทุกเงื่อนไข" เพื่อเอาไปแสดงในตาราง Matrix จริงๆ
      let fullyFilteredData = filterData('None');

      // 2. คำนวณหาตัวเลือก (Options) ที่เป็นไปได้ของแต่ละ Dropdown
      let validModels = new Set(), validSessions = new Set(), validMonths = new Set(), validLines = new Set();
      
      filterData('Model').forEach(r => { if(r.model) validModels.add(r.model); });
      filterData('Session').forEach(r => { if(r.session) validSessions.add(r.session); });
      filterData('Month').forEach(r => { let m = getMonthString(r.timestamp); if(m) validMonths.add(m); });
      filterData('Line').forEach(r => { if(r.line && r.line !== "-") validLines.add(r.line); });

      // 3. ฟังก์ชันอัปเดต Dropdown พร้อมเคลียร์ค่าที่ขัดแย้ง (Auto-Clear Invalid Selections)
      const updateDropdown = (id, validSet, currentSelections) => {
          let el = $('#' + id);
          let newSelections = [];
          
          // เช็คว่าค่าเดิมที่เลือกไว้ ยังอยู่ในรายการที่ถูกต้องหรือไม่ ถ้าไม่ ให้ลบทิ้ง
          currentSelections.forEach(val => {
              if (validSet.has(val)) newSelections.push(val);
          });
          
          el.empty(); // ล้างตัวเลือกเก่า
          Array.from(validSet).sort().forEach(val => {
              el.append(new Option(val, val, false, false));
          });
          
          // อัปเดตค่าที่ถูกเลือกกลับเข้าไป (ใช้ change.select2 เพื่อให้ UI อัปเดตโดยไม่ไป Trigger ให้ระบบลูปตัวเอง)
          el.val(newSelections).trigger('change.select2'); 
      };

      // ทำการอัปเดตทั้ง 4 Dropdown
      updateDropdown('filter-model', validModels, selModels);
      updateDropdown('filter-session', validSessions, selSessions);
      updateDropdown('filter-date', validMonths, selMonths);
      updateDropdown('filter-line', validLines, selLines);

      // 4. วาดตารางข้อมูลส่งท้าย
      if (typeof currentFilteredMatrixData !== 'undefined') {
          currentFilteredMatrixData = fullyFilteredData; 
      }
      renderMatrixTable(fullyFilteredData);

    } catch (error) {
      console.error("Error in applyMatrixFilters:", error);
      swalModern.fire('UI Error', 'เกิดข้อผิดพลาดในการกรองข้อมูล: ' + error.message, 'error');
    }
  }
  function exportMatrixToExcel() {
    if (!currentFilteredMatrixData || currentFilteredMatrixData.length === 0) {
      return swalModern.fire('Notice', 'No data to export based on current filters.', 'warning');
    }
    downloadExcelStream(
      '/api/export/matrix',
      { data: currentFilteredMatrixData },
      `SummaryMatrix_${Date.now()}.xlsx`
    );
  }

  function renderMatrixTable(data) {
    const container = document.getElementById("matrixAccordion");
    if (data.length === 0) {
      container.innerHTML = `<div class="text-center py-5 text-muted bg-white rounded-4 border">No data found matching the selected filters.</div>`;
      return;
    }
    
    // จัดกลุ่มข้อมูล (Group By Model + Session)
    let groups = {};
    data.forEach(item => {
       let key = `${item.model}___${item.session}`;
       if(!groups[key]) {
          groups[key] = {
             model: item.model, session: item.session,
             progress: item.progress, totalCT: item.totalModelCT,
             bottleneck: item.bottleneck, timestamp: item.timestamp,
             stations: []
          };
       }
       groups[key].stations.push(item);
    });

    let html = "";
    let index = 0;
    const parseR = (val) => (!val || isNaN(parseFloat(val))) ? "-" : parseFloat(val).toFixed(2);

    for (let key in groups) {
       let g = groups[key];
       let colId = `collapse_${index}`;
       let headId = `heading_${index}`;

       let rowsHtml = "";
       let incompleteMainStations = new Set();

       g.stations.forEach(st => {
          let avgDisplay = st.avgCT > 0 ? st.avgCT.toFixed(2) : "-";
          
          // [เพิ่มใหม่] ตรวจสอบว่ามีข้อมูล Line หรือไม่ ถ้ามีให้สร้าง Badge HTML เล็กๆ เตรียมไว้
          let lineBadge = st.line && st.line !== "-" ? ` <span class="badge bg-secondary bg-opacity-10 text-secondary border ms-1" style="font-size:0.7rem;">Line: ${st.line}</span>` : "";

          // [แก้ไข UI ใน Summary Matrix ให้แสดง Line แบบ Badge เล็กๆ ท้ายชื่อ Station]
          rowsHtml += `<tr>
            <td class="text-start ps-4 fw-bold text-info">${st.station}${lineBadge}</td>
            <td class="text-start text-muted">${st.operator || '-'}</td>
            <td class="text-start text-muted">${st.checker || '-'}</td>
            <td>${parseR(st.r1)}</td><td>${parseR(st.r2)}</td><td>${parseR(st.r3)}</td>
            <td>${parseR(st.r4)}</td><td>${parseR(st.r5)}</td><td>${parseR(st.r6)}</td>
            <td>${parseR(st.r7)}</td><td>${parseR(st.r8)}</td><td>${parseR(st.r9)}</td>
            <td>${parseR(st.r10)}</td>
            <td class="fw-bold text-primary bg-primary bg-opacity-10">${avgDisplay}</td>
          </tr>`;

          if (!st.avgCT || st.avgCT <= 0) {
             let mainName = st.station.split(" (")[0].trim();
             incompleteMainStations.add(mainName);
          }
       });

       let missingArr = Array.from(incompleteMainStations);
       let missingTextHtml = "";
       if (missingArr.length > 0) {
           let displayMissing = missingArr.slice(0, 2).join(", ");
           let moreCount = missingArr.length - 2;
           if (moreCount > 0) {
               displayMissing += ` (+${moreCount} more)`;
           }
           missingTextHtml = `<span class="badge bg-secondary bg-opacity-10 text-secondary border border-secondary" title="Stations not completed"><i class="fa-solid fa-circle-exclamation me-1"></i> Missing: ${displayMissing}</span>`;
       }

       // Logic รองรับการแปลง Progress
       let rawProgress = String(g.progress || "0").trim();
       let progressInt = 0;

       if (rawProgress.includes("%")) {
           progressInt = parseInt(rawProgress.replace("%", "")) || 0;
       } else {
           let floatVal = parseFloat(rawProgress);
           if (!isNaN(floatVal)) {
               if (floatVal <= 1 && floatVal > 0) {
                   progressInt = Math.round(floatVal * 100); 
               } else {
                   progressInt = Math.round(floatVal);
               }
           }
       }
       
       let progressDisplay = progressInt + "%";

       let progressColorClass = "bg-secondary text-secondary border-secondary"; 
       if (progressInt >= 1 && progressInt <= 30) {
           progressColorClass = "bg-danger text-danger border-danger"; 
       } else if (progressInt >= 31 && progressInt <= 99) {
           progressColorClass = "bg-warning text-warning border-warning"; 
       } else if (progressInt === 100) {
           progressColorClass = "bg-success text-success border-success"; 
       }

       // [แก้ไข] ลบ namesHtml ที่แสดง Badge ชื่อบน Header ออก
       html += `
       <div class="accordion-item border mb-3 rounded-4 overflow-hidden shadow-sm">
         <h2 class="accordion-header position-relative" id="${headId}">
           <button class="accordion-button collapsed bg-white py-3 ps-4 pe-4" type="button" data-bs-toggle="collapse" data-bs-target="#${colId}">
              <div class="d-flex flex-wrap align-items-center gap-2 fw-bold" style="max-width: calc(100% - 280px);">
                <span class="badge bg-primary fs-6">${g.model}</span>
                <span class="text-muted d-flex align-items-center"><i class="fa-solid fa-folder-tree me-1"></i> ${g.session}</span>
                <span class="badge ${progressColorClass} bg-opacity-10 border"><i class="fa-solid fa-bars-progress me-1"></i> ${progressDisplay}</span>
                
                ${missingTextHtml}
              </div>
           </button>
           
           <div class="position-absolute top-50 translate-middle-y d-flex align-items-center gap-3" style="right: 60px; z-index: 5;">
              <small class="text-muted fw-normal d-none d-xl-block" style="font-size:0.75rem; white-space: nowrap;">อัปเดต: ${g.timestamp}</small>
              <button class="btn btn-sm btn-primary fw-bold text-white shadow-sm px-3" onclick="openDashboardFromMatrix('${g.model}', '${g.session}')" style="white-space: nowrap;">
                 <i class="fa-solid fa-chart-pie me-1"></i> Dashboard
              </button>
           </div>
         </h2>

         <div id="${colId}" class="accordion-collapse collapse" data-bs-parent="#matrixAccordion">
           <div class="accordion-body p-0">
             <div class="table-responsive">
               <table class="table table-hover mb-0 text-center align-middle border-0" style="min-width: 1100px;">
                 <thead class="table-light text-uppercase small tracking-wider border-bottom">
                   <tr>
                     <th class="py-3 text-start ps-4">Station</th>
                     <!-- [แก้ไข] เพิ่ม Header คอลัมน์ Operator และ Checker -->
                     <th class="py-3 text-start text-muted">Operator</th>
                     <th class="py-3 text-start text-muted">Checker</th>
                     <th class="py-3 text-muted">R1</th><th class="py-3 text-muted">R2</th><th class="py-3 text-muted">R3</th>
                     <th class="py-3 text-muted">R4</th><th class="py-3 text-muted">R5</th><th class="py-3 text-muted">R6</th>
                     <th class="py-3 text-muted">R7</th><th class="py-3 text-muted">R8</th><th class="py-3 text-muted">R9</th>
                     <th class="py-3 text-muted">R10</th>
                     <th class="py-3 text-primary bg-primary bg-opacity-10">Avg CT (s)</th>
                   </tr>
                 </thead>
                 <tbody class="fw-medium border-0 bg-white">${rowsHtml}</tbody>
               </table>
             </div>
           </div>
         </div>
       </div>
       `;
       index++;
    }
    container.innerHTML = html;
  }

  function backToSelectFromMatrix() {
    document.getElementById("section-matrix").classList.add("d-none");
    document.getElementById("section-select").classList.remove("d-none");
  }

  // ==========================================================================
  // [ส่วนของการจัดการ Cache Local Storage]
  // ==========================================================================
  
  function getDraftCacheKey() {
    return `TS_DRAFT_${currentModel}_${currentSessionTag}_${currentStation}`;
  }

  function saveDraftCache() {
    if (!currentStation || !currentModel) return;
    let cyclesData = [];
    for (let i = 1; i <= 10; i++) {
      let ct = document.getElementById(`cycletime-${i}`)?.value || "";
      let rm = document.getElementById(`remark-${i}`)?.value || "";
      cyclesData.push({ ct: ct, rm: rm });
    }
    let draftPayload = {
      cycles: cyclesData,
      currentRound: currentRound,
      effCavity: currentEffCavity,
      operator: document.getElementById("operator-name")?.value || "",
      checker: document.getElementById("checker-name")?.value || ""
    };
    localStorage.setItem(getDraftCacheKey(), JSON.stringify(draftPayload));
  }

  function loadDraftCache() {
    if (!currentStation || !currentModel) return;
    let raw = localStorage.getItem(getDraftCacheKey());
    
    // [เพิ่มใหม่] ล้างช่องชื่อรอไว้เสมอ (ป้องกันข้อมูลขยะค้าง)
    let elOp = document.getElementById("operator-name");
    let elChk = document.getElementById("checker-name");
    if(elOp) elOp.value = "";
    if(elChk) elChk.value = "";

    if (!raw) return;
    
    try {
      let draft = JSON.parse(raw);
      if (draft && draft.cycles && Array.isArray(draft.cycles)) {
        draft.cycles.forEach((item, index) => {
          let roundIndex = index + 1;
          let elCt = document.getElementById(`cycletime-${roundIndex}`);
          let elRm = document.getElementById(`remark-${roundIndex}`);
          if (elCt) elCt.value = item.ct || "";
          if (elRm) elRm.value = item.rm || "";
        });
        currentRound = draft.currentRound || 1;
        
        // [เพิ่มใหม่] นำชื่อกลับมาใส่ฟอร์ม
        if (elOp && draft.operator) elOp.value = draft.operator;
        if (elChk && draft.checker) elChk.value = draft.checker;

        calculateAvg();
      }
    } catch(e) {
      console.error("Failed to parse draft cache", e);
    }
  }

  function clearDraftCache() {
    if (!currentStation || !currentModel) return;
    localStorage.removeItem(getDraftCacheKey());
  }

  function clearTableData() {
    swalModern.fire({
      title: 'Clear all entries?',
      text: 'This will reset all recorded rounds and remarks for this station.',
      icon: 'warning',
      showCancelButton: true,
      confirmButtonText: 'Yes, Clear All',
      customClass: { confirmButton: 'btn btn-danger px-4', cancelButton: 'btn btn-outline-secondary px-4' }
    }).then((res) => {
      if (res.isConfirmed) {
        for (let i = 1; i <= 10; i++) {
          let el = document.getElementById(`cycletime-${i}`);
          if (el) el.value = "";
          let rm = document.getElementById(`remark-${i}`);
          if (rm) rm.value = "";
        }
        currentRound = 1;
        resetStopwatch();
        calculateAvg();
        // [แก้ไข] เปลี่ยนเป็น save เพื่อเซฟชื่อทับลงไป แต่เวลากลายเป็นค่าว่าง แทนที่จะเคลียร์ลบหมด
        saveDraftCache(); 
        checkPullButtonVisibility(); // [แทรกตรงนี้] ถ้าล้างตารางแล้ว ให้ปุ่มโชว์กลับมาใหม่
      }
    });
  }

  let currentPullDataList = [];

  // 1. ฟังก์ชันเช็คว่าจะซ่อนหรือโชว์ปุ่ม (ป้องกันการ Overwrite)
  function checkPullButtonVisibility() {
    let btn = document.getElementById("btn-pull-data");
    if (!btn) return;

    let hasData = false;
    for (let i = 1; i <= 10; i++) {
      let el = document.getElementById(`cycletime-${i}`);
      if (el && parseFloat(el.value) > 0) {
        hasData = true; break;
      }
    }

    // ถ้าตารางมีตัวเลขอยู่แล้ว หรือ สถานีนี้เคยถูกเซฟลง Completed แล้ว -> ให้ซ่อนปุ่ม
    if (hasData || completedStations.includes(currentStation)) {
      btn.classList.add("d-none");
    } else {
      btn.classList.remove("d-none");
    }
  }

  // 2. ฟังก์ชันเมื่อกดปุ่ม (โหลด Dropdown)
  function promptPullData() {
    swalModern.fire({ title: 'Searching available data...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
    
    google.script.run
      .withSuccessHandler((list) => {
        if (!list || list.length === 0) {
           return swalModern.fire('Not Found', 'ไม่มีข้อมูลของสถานีนี้ใน Model หรือ Session อื่นๆ', 'info');
        }
        currentPullDataList = list;

        // สร้าง Dropdown (<select>) โชว์รายการที่พบ
        let optionsHtml = '<select id="swal-pull-select" class="form-select border-primary fw-bold text-primary mb-3">';
        list.forEach((item, idx) => {
           optionsHtml += `<option value="${idx}">[${item.model}] ${item.session} (Avg CT: ${item.totalCT}s)</option>`;
        });
        optionsHtml += '</select>';

        swalModern.fire({
           title: 'Pull Data from...',
           html: `<div class="text-start mb-2 text-muted small fw-bold">Select source to copy 10-round data:</div>${optionsHtml}`,
           showCancelButton: true,
           confirmButtonText: '<i class="fa-solid fa-download"></i> Copy Data'
        }).then((res) => {
           if (res.isConfirmed) {
              applyPullData(currentPullDataList[document.getElementById('swal-pull-select').value]);
           }
        });
      })
      .withFailureHandler(err => swalModern.fire('Error', err.message, 'error'))
      .getAvailablePullData(currentStation, currentModel, currentSessionTag);
  }

  // 3. ฟังก์ชันนำข้อมูลมาหยอดใส่ฟอร์ม
  function applyPullData(data) {
    document.getElementById("operator-name").value = data.operator || "";
    document.getElementById("checker-name").value = data.checker || "";

    for (let i = 1; i <= 10; i++) {
       let elCt = document.getElementById(`cycletime-${i}`);
       let elRm = document.getElementById(`remark-${i}`);
       if (elCt) elCt.value = data.r[i-1] !== "" ? data.r[i-1] : "";
       if (elRm) elRm.value = data.remarks[i-1] || "";
    }
    currentRound = 11; // ดันรอบจับเวลาให้เต็ม
    calculateAvg();
    saveDraftCache();
    checkPullButtonVisibility(); // ซ่อนปุ่มทันทีเพื่อกันกดซ้ำ
    swalModern.fire({ icon: 'success', title: 'Data Copied', timer: 1500, showConfirmButton: false });
  }

  function backToMainLayout() { 
    renderMainStations(); 
    document.getElementById("section-sub-layout").classList.add("d-none"); 
    document.getElementById("section-layout").classList.remove("d-none"); 
  }

  function backToSelectFromDashboard() { 
    document.getElementById("dashboard-table-body").innerHTML = "";
    document.getElementById("insight-metrics").classList.add("d-none");
    if (webChartInstance) {
      webChartInstance.destroy();
      webChartInstance = null;
    }
    
    document.getElementById("section-dashboard").classList.add("d-none"); 
    
    // [แก้ไข] เช็คว่าถ้ามาจาก Matrix ให้กลับไป Matrix
    if (isNavigatedFromMatrix) {
      document.getElementById("section-matrix").classList.remove("d-none"); 
      isNavigatedFromMatrix = false; // รีเซ็ตสถานะ
    } else {
      // Fallback
      document.getElementById("section-select").classList.remove("d-none"); 
    }
  }

let currentMasterRouting = [];
let editMasterOriginalModel = null;

// แสดงปุ่มเมื่อเป็น Staff
function checkMasterPermission() {
   if (isStaffMode) document.getElementById('btn-master-management').classList.remove('d-none');
}

function openMasterManagement() {
  document.getElementById("section-select").classList.add("d-none"); // แก้ไข: ซ่อนหน้า section-select
  document.getElementById("section-master-data").classList.remove("d-none");
  renderMasterDataTable();
}

function closeMasterManagement() {
  document.getElementById("section-master-data").classList.add("d-none");
  document.getElementById("section-select").classList.remove("d-none"); // แก้ไข: กลับไปแสดงหน้า section-select
  loadInitialData(); // รีเฟรชข้อมูลหน้าแรก
}

function renderMasterDataTable() {
  const tbody = document.getElementById("master-data-tbody");
  // [แก้ไข] เปลี่ยน colspan="5" เป็น "4" เพื่อให้พอดีกับจำนวนคอลัมน์ที่เหลือ
  tbody.innerHTML = `<tr><td colspan="4" class="text-muted py-4"><i class="fa-solid fa-spinner fa-spin me-2"></i>Loading Master Data...</td></tr>`;
  
  google.script.run.withSuccessHandler(data => {
    allMasterDataList = data || [];
    filterMasterDataTable(); // เรียกประมวลผลการกรองทันทีหลังดึงข้อมูลสำเร็จ
  }).getMasterDataList();
}

// [เพิ่มใหม่] ฟังก์ชัน Real-time Filter สำหรับค้นหาชื่อ Model ในการ์ด Master Data
function filterMasterDataTable() {
  const searchInput = document.getElementById('master-search-input');
  const clearBtn = document.getElementById('btn-clear-master-search');
  const searchTerm = searchInput ? searchInput.value.trim().toUpperCase() : "";

  // ควบคุมการแสดงผลปุ่มล้างคำค้นหา (X)
  if (clearBtn) {
    if (searchTerm !== "") {
      clearBtn.classList.remove('d-none');
    } else {
      clearBtn.classList.add('d-none');
    }
  }

  // กรองเฉพาะรายการที่ MODEL NAME ตรงกับคำค้นหา
  const filteredData = allMasterDataList.filter(item => {
    if (!searchTerm) return true;
    return item.model && item.model.toString().toUpperCase().includes(searchTerm);
  });

  displayMasterDataTable(filteredData, searchTerm);
}

// [เพิ่มใหม่] ฟังก์ชันล้างค่าคำค้นหาเมื่อกดปุ่ม (X)
function clearMasterSearch() {
  const searchInput = document.getElementById('master-search-input');
  if (searchInput) searchInput.value = "";
  filterMasterDataTable();
}

// [เพิ่มใหม่] ฟังก์ชัน Render HTML ตาราง Master Data แยกจาก Logic เพื่อให้อ่านง่ายและไม่ซ้ำซ้อน
function displayMasterDataTable(dataList, searchTerm = "") {
  const tbody = document.getElementById("master-data-tbody");
  tbody.innerHTML = "";

  if (!dataList || dataList.length === 0) {
    let msg = searchTerm 
      ? `No master models found matching "${searchTerm}".`
      : `No master data found.`;
    // [แก้ไข] เปลี่ยน colspan="5" เป็น "4"
    tbody.innerHTML = `<tr><td colspan="4" class="text-muted py-4">${msg}</td></tr>`;
    return;
  }

  dataList.forEach(row => {
    let routingHtml = "";
    try {
      let rJson = JSON.parse(row.routingStr || "[]");
      rJson.forEach(main => {
         let subCount = main.subs ? main.subs.length : 0;
         routingHtml += `<span class="badge bg-primary bg-opacity-10 text-primary border border-primary me-1 mb-1 fw-normal px-2 py-1" style="border-radius:12px;">${main.name} <small class="text-muted ms-1">(${subCount} subs)</small></span>`;
      });
    } catch(e) {}

    // [แก้ไข] ลบ <td class="text-muted"><span class="badge bg-light text-dark border">${row.line || '-'}</span></td> บรรทัดแรกทิ้งไป
    tbody.innerHTML += `
      <tr>
        <td class="fw-bold text-primary fs-6">${row.model}</td>
        <td class="fw-bold">${row.cavity} <small class="text-muted fw-normal">pcs/panel</small></td>
        <td class="text-start ps-4" style="max-width: 400px; flex-wrap: wrap;">${routingHtml || '-'}</td>
        <td>
          <button class="btn btn-sm btn-warning text-dark fw-bold px-3 me-2 mb-1 rounded-pill shadow-sm" onclick="openMasterModal('${row.model}')">
            <i class="fa-solid fa-pen"></i> Edit
          </button>
          <button class="btn btn-sm btn-info text-white fw-bold px-3 me-2 mb-1 rounded-pill shadow-sm" onclick="copyMasterData('${row.model}')">
            <i class="fa-solid fa-copy"></i> Copy
          </button>
          <button class="btn btn-sm btn-danger text-white fw-bold px-3 mb-1 rounded-pill shadow-sm" onclick="deleteMasterData('${row.model}')">
            <i class="fa-solid fa-trash"></i> Delete
          </button>
        </td>
      </tr>`;
  });
}

function openMasterModal(modelName = null) {
  editMasterOriginalModel = modelName;
  document.getElementById('masterModalTitle').textContent = modelName ? "Edit Master Model" : "Create New Master Model";
  
  if (modelName) {
    // โหลดข้อมูลเก่ามาโชว์
    swalModern.fire({ title: 'Loading...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
    google.script.run.withSuccessHandler(data => {
      let row = data.find(d => d.model === modelName);
      if(row) {
        // ❌ ลบบรรทัดนี้ออก: document.getElementById('master-line').value = row.line || "";
        document.getElementById('master-model').value = row.model;
        document.getElementById('master-cavity').value = row.cavity || 1;
        try { currentMasterRouting = JSON.parse(row.routingStr || "[]"); } catch(e) { currentMasterRouting = []; }
        renderMasterFormRouting();
        Swal.close();
        new bootstrap.Modal(document.getElementById('masterDataModal')).show();
      }
    }).getMasterDataList();
  } else {
    // สร้างใหม่
    // ❌ ลบบรรทัดนี้ออก: document.getElementById('master-line').value = "";
    document.getElementById('master-model').value = "";
    document.getElementById('master-cavity').value = "1";
    currentMasterRouting = [];
    renderMasterFormRouting();
    new bootstrap.Modal(document.getElementById('masterDataModal')).show();
  }
}

// [เพิ่มใหม่] ฟังก์ชันคัดลอก Master Data
function copyMasterData(modelName) {
  editMasterOriginalModel = null; 
  document.getElementById('masterModalTitle').textContent = "Copy Master Model (From: " + modelName + ")";
  
  swalModern.fire({ title: 'Loading...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
  google.script.run.withSuccessHandler(data => {
    let row = data.find(d => d.model === modelName);
    if(row) {
      // ❌ ลบบรรทัดนี้ออก: document.getElementById('master-line').value = row.line || "";
      document.getElementById('master-model').value = row.model + "-COPY"; 
      document.getElementById('master-cavity').value = row.cavity || 1;
      try { currentMasterRouting = JSON.parse(row.routingStr || "[]"); } catch(e) { currentMasterRouting = []; }
      renderMasterFormRouting();
      Swal.close();
      new bootstrap.Modal(document.getElementById('masterDataModal')).show();
    }
  }).getMasterDataList();
}

// [เพิ่มใหม่] ฟังก์ชันเลื่อน Main Station ขึ้น/ลง
function masterMoveMain(idx, direction) {
  if (direction === 'up' && idx > 0) {
    let temp = currentMasterRouting[idx];
    currentMasterRouting[idx] = currentMasterRouting[idx - 1];
    currentMasterRouting[idx - 1] = temp;
  } else if (direction === 'down' && idx < currentMasterRouting.length - 1) {
    let temp = currentMasterRouting[idx];
    currentMasterRouting[idx] = currentMasterRouting[idx + 1];
    currentMasterRouting[idx + 1] = temp;
  }
  renderMasterFormRouting();
}

// [เพิ่มใหม่] ฟังก์ชันเลื่อน Sub Station ขึ้น/ลง
function masterMoveSub(mainIdx, subIdx, direction) {
  let subs = currentMasterRouting[mainIdx].subs;
  if (direction === 'up' && subIdx > 0) {
    let temp = subs[subIdx];
    subs[subIdx] = subs[subIdx - 1];
    subs[subIdx - 1] = temp;
  } else if (direction === 'down' && subIdx < subs.length - 1) {
    let temp = subs[subIdx];
    subs[subIdx] = subs[subIdx + 1];
    subs[subIdx + 1] = temp;
  }
  renderMasterFormRouting();
}


// --- Dynamic Form Logic ---
function masterAddMain() {
  // [แก้ไข] เปลี่ยนจาก "NEW MAIN PROCESS" เป็น "" (ค่าว่าง) เพื่อให้แสดงผลเป็น Placeholder
  currentMasterRouting.push({ name: "", subs: [] });
  renderMasterFormRouting();
}
function masterAddSub(mainIdx) {
  // [แก้ไข] เปลี่ยนจาก "NEW SUB" เป็น "" (ค่าว่าง)
  currentMasterRouting[mainIdx].subs.push({ name: "", unit: "Single", customDivisor: null });
  renderMasterFormRouting();
}
function masterDelMain(mainIdx) { currentMasterRouting.splice(mainIdx, 1); renderMasterFormRouting(); }
function masterDelSub(mainIdx, subIdx) { currentMasterRouting[mainIdx].subs.splice(subIdx, 1); renderMasterFormRouting(); }

function renderMasterFormRouting() {
  const container = document.getElementById("master-routing-container");
  
  // [Defensive] เคลียร์ SortableJS Instance เก่าทิ้ง ป้องกัน Memory Leak และบั๊กลากซ้อน
  if(masterMainSortableInstance) { masterMainSortableInstance.destroy(); masterMainSortableInstance = null; }
  masterSubSortableInstances.forEach(s => s.destroy());
  masterSubSortableInstances = [];

  let html = "";
  currentMasterRouting.forEach((main, mIdx) => {
    let subsHtml = `<div class="sub-routing-container" id="sub-container-${mIdx}">`;
    main.subs.forEach((sub, sIdx) => {
       let isCustom = sub.unit === 'Custom';
       subsHtml += `
       <!-- [แก้ไข] ใช้ compact-row จัดการให้อยู่บรรทัดเดียว และลบ margin ซ้ายให้เหลือพื้นที่มากขึ้น -->
       <div class="compact-row ms-2 ms-md-4 mb-2 p-1 border rounded bg-white sub-item" data-idx="${sIdx}">
          
          <div class="text-muted px-1 flex-shrink-0" style="cursor: grab;" title="Drag to reorder"><i class="fa-solid fa-grip-vertical"></i></div>
          <div class="btn-group btn-group-sm flex-shrink-0 me-1">
            <button class="btn btn-light border px-1" onclick="masterMoveSub(${mIdx}, ${sIdx}, 'up')" ${sIdx === 0 ? 'disabled' : ''}><i class="fa-solid fa-arrow-up"></i></button>
            <button class="btn btn-light border px-1" onclick="masterMoveSub(${mIdx}, ${sIdx}, 'down')" ${sIdx === main.subs.length - 1 ? 'disabled' : ''}><i class="fa-solid fa-arrow-down"></i></button>
          </div>
          
          <!-- [แก้ไข] ใส่ Placeholder และคลาส compact-input -->
          <input type="text" class="form-control form-control-sm compact-input fw-bold" value="${sub.name}" placeholder="NEW SUB" onchange="currentMasterRouting[${mIdx}].subs[${sIdx}].name = this.value.toUpperCase()">
          
          <select class="form-select form-select-sm compact-select text-secondary flex-shrink-0 ms-1" onchange="currentMasterRouting[${mIdx}].subs[${sIdx}].unit = this.value; renderMasterFormRouting();">
            <option value="Single" ${sub.unit === 'Single' ? 'selected' : ''}>Single Piece</option>
            <option value="Panel" ${sub.unit === 'Panel' ? 'selected' : ''}>Panel Flow</option>
            <option value="Custom" ${isCustom ? 'selected' : ''}>Custom Divisor</option>
          </select>
          
          <!-- [แก้ไข] ใส่คลาส compact-qty สำหรับช่องตัวเลข -->
          <input type="number" class="form-control form-control-sm compact-qty border-primary text-primary flex-shrink-0 ms-1 ${isCustom ? '' : 'd-none'}" placeholder="Qty" min="1" value="${sub.customDivisor || ''}" onchange="currentMasterRouting[${mIdx}].subs[${sIdx}].customDivisor = parseInt(this.value)">
          
          <button class="btn btn-sm text-danger flex-shrink-0 ms-1 px-1" onclick="masterDelSub(${mIdx}, ${sIdx})"><i class="fa-solid fa-xmark"></i></button>
       </div>`;
    });
    subsHtml += `</div>`; 

    html += `
    <div class="border rounded-4 bg-light p-2 mb-3 shadow-sm main-item" data-idx="${mIdx}">
       <div class="compact-row mb-2">
         
         <div class="text-muted px-1 fs-6 flex-shrink-0" style="cursor: grab;" title="Drag to reorder"><i class="fa-solid fa-grip-vertical"></i></div>
         <div class="btn-group btn-group-sm me-1 flex-shrink-0">
           <button class="btn btn-white border bg-white px-1" onclick="masterMoveMain(${mIdx}, 'up')" ${mIdx === 0 ? 'disabled' : ''}><i class="fa-solid fa-arrow-up"></i></button>
           <button class="btn btn-white border bg-white px-1" onclick="masterMoveMain(${mIdx}, 'down')" ${mIdx === currentMasterRouting.length - 1 ? 'disabled' : ''}><i class="fa-solid fa-arrow-down"></i></button>
         </div>

         <span class="badge bg-secondary rounded-circle p-2 flex-shrink-0 me-1">${mIdx + 1}</span>
         
         <!-- [แก้ไข] ใส่ Placeholder และคลาส compact-input -->
         <input type="text" class="form-control compact-input fw-bold" value="${main.name}" placeholder="MAIN PROCESS" onchange="currentMasterRouting[${mIdx}].name = this.value.toUpperCase()">
         
         <!-- [เพิ่มใหม่] ช่องใส่ Supported Lines -->
         <input type="text" class="form-control compact-input text-info border-info ms-1 flex-shrink-0" style="max-width: 150px;" value="${main.lines || ''}" placeholder="Lines (e.g. A1, A2)" title="Supported Lines separated by comma" onchange="let cleanVal = this.value.toUpperCase().replace(/[&/]/g, ','); this.value = cleanVal.split(',').map(s => s.trim()).filter(s => s).join(','); currentMasterRouting[${mIdx}].lines = this.value;">
         
         <button class="btn btn-sm btn-outline-primary px-2 rounded-pill fw-bold flex-shrink-0 ms-1" onclick="masterAddSub(${mIdx})">+ Sub</button>
         <button class="btn btn-sm text-danger ms-auto flex-shrink-0 px-2" onclick="masterDelMain(${mIdx})"><i class="fa-solid fa-trash"></i></button>
       </div>
       ${subsHtml}
    </div>`;
  });
  
  // (โครงสร้าง SortableJS อิง Logic เดิม)
  container.innerHTML = html || '<div class="text-center text-muted py-3">No routing sequence. Please add Main Station.</div>';

  if (currentMasterRouting.length > 0) {
    masterMainSortableInstance = new Sortable(container, {
      animation: 150, handle: '.fa-grip-vertical', draggable: '.main-item', ghostClass: 'bg-white',
      onEnd: function (evt) {
        let movedItem = currentMasterRouting.splice(evt.oldIndex, 1)[0];
        currentMasterRouting.splice(evt.newIndex, 0, movedItem);
        renderMasterFormRouting();
      }
    });

    currentMasterRouting.forEach((main, mIdx) => {
      let subCont = document.getElementById(`sub-container-${mIdx}`);
      if(subCont) {
        let sSortable = new Sortable(subCont, {
          animation: 150, handle: '.fa-grip-vertical', draggable: '.sub-item', ghostClass: 'bg-light',
          onEnd: function (evt) {
            let movedSub = currentMasterRouting[mIdx].subs.splice(evt.oldIndex, 1)[0];
            currentMasterRouting[mIdx].subs.splice(evt.newIndex, 0, movedSub);
            renderMasterFormRouting();
          }
        });
        masterSubSortableInstances.push(sSortable);
      }
    });
  }
}

function saveMasterData() {
  // ❌ ลบบรรทัดนี้ออก: let line = document.getElementById('master-line').value.trim();
  let model = document.getElementById('master-model').value.trim().toUpperCase();
  let cavity = parseInt(document.getElementById('master-cavity').value) || 1;
  
  if(!model) return swalModern.fire('Error', 'Model Name is required!', 'error');

  // [เพิ่มใหม่] บังคับให้ทุก Main Station ต้องระบุ Line (โค้ดเดิมที่คุณน่าจะมีอยู่แล้ว)
  for (let i = 0; i < currentMasterRouting.length; i++) {
    let m = currentMasterRouting[i];
    if (!m.lines || m.lines.trim() === "") {
      return swalModern.fire('Validation Error', `Please specify Supported Line(s) for Main Station: ${m.name || (i+1)}`, 'warning');
    }
  }

  swalModern.fire({ title: 'Saving Master Data...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
  let routingStr = JSON.stringify(currentMasterRouting);
  
  // สังเกตตรงพารามิเตอร์ที่ 2 (Line) เราส่งเป็น "-" Hardcode ไปเลยตามที่ออกแบบไว้
  google.script.run.withSuccessHandler(res => {
    if(res.success) {
       swalModern.fire('Saved!', 'Master Data updated successfully.', 'success');
       bootstrap.Modal.getInstance(document.getElementById('masterDataModal')).hide();
       renderMasterDataTable();
    } else {
       swalModern.fire('Error', res.message, 'error');
    }
  }).saveMasterModelData(editMasterOriginalModel, "-", model, cavity, routingStr);
}

function deleteMasterData(modelName) {
  swalModern.fire({
    title: `Delete ${modelName}?`, text: "This will permanently remove the Master Data. You cannot undo this.", icon: 'warning',
    showCancelButton: true, confirmButtonColor: '#ef4444', confirmButtonText: 'Yes, Delete'
  }).then((result) => {
    if (result.isConfirmed) {
      swalModern.fire({ title: 'Deleting...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
      google.script.run.withSuccessHandler(res => {
         if(res.success) { swalModern.fire('Deleted!', '', 'success'); renderMasterDataTable(); }
         else { swalModern.fire('Error', res.message, 'error'); }
      }).deleteMasterModelData(modelName);
    }
  });
}

// เพิ่มบรรทัดนี้ไปในฟังก์ชันเช็ค Role เดิมของคุณเพื่อเปิดใช้งานปุ่ม
// setTimeout(checkMasterPermission, 1500);
function confirmGoHome() {
    // 1. ตรวจสอบว่าผู้ใช้กำลังอยู่ในหน้าฟอร์มจับเวลาหรือไม่
    const formSection = document.getElementById("section-form");
    const isFormVisible = formSection && !formSection.classList.contains("d-none");
    
    if (isFormVisible) {
      // กรณีที่ 1: กำลังจับเวลาอยู่ ให้แจ้งเตือนก่อน
      swalModern.fire({
        title: 'Discard Unsaved Data?',
        text: 'You are currently in the Time Study Form. Returning to Home will discard your current unsaved progress.',
        icon: 'warning',
        showCancelButton: true,
        confirmButtonText: 'Yes, Go Home',
        cancelButtonText: 'Cancel',
        customClass: { confirmButton: 'btn btn-danger px-4', cancelButton: 'btn btn-outline-secondary px-4' }
      }).then((res) => {
        if (res.isConfirmed) {
          executeGoHome();
        }
      });
    } else {
      // กรณีที่ 2: อยู่หน้าอื่นๆ (หรือหน้าแรก) ให้กลับและรีเฟรชข้อมูลได้เลย
      executeGoHome();
    }
  }

  function executeGoHome() {
    // 1. Defensive Check: เคลียร์ State ที่อาจค้างอยู่เพื่อป้องกันบั๊ก
    if (isStopwatchRunning) {
      resetStopwatch();
    }
    if (webChartInstance) {
      webChartInstance.destroy(); // ป้องกัน Canvas Memory Leak
      webChartInstance = null;
    }
    isNavigatedFromMatrix = false;

    // 2. ปิดหน้าจอ (Section) ทั้งหมด ยกเว้นหน้าแรก
    const sections = ["section-layout", "section-sub-layout", "section-form", "section-dashboard", "section-matrix", "section-master-data"];
    sections.forEach(sec => {
      let el = document.getElementById(sec);
      if (el) el.classList.add("d-none");
    });
    
    // 3. แสดงหน้าแรก (Selection)
    document.getElementById("section-select").classList.remove("d-none");
    
    // 4. ล้างค่าในฟอร์มหน้าแรก
    document.getElementById('session-name').value = '';
    $('#model-select').val(null).trigger('change'); // ใช้ null เพื่อสั่งเคลียร์ค่า Select2 ให้หมดจด
    $('#existing-session-select').val('').trigger('change');
    
    // 5. แสดงหน้า Loading รอการดึงข้อมูลใหม่
    document.getElementById("config-ready").classList.add("d-none");
    document.getElementById("loading-config").classList.remove("d-none");

    // 6. เรียกฟังก์ชันดึงข้อมูลล่าสุดจาก Backend เสมอ
    loadInitialData();
  }
