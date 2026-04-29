const STORAGE_KEY = "weedless-scheduler-v1";
const SERVICES = [
  "Irrigation Repair",
  "Irrigation Install",
  "Lawn Treatment",
  "Overseeding",
  "Fertilization",
  "Aeration",
  "Follow-up",
];
const LAWN_TREATMENT_SERVICE = "Lawn Treatment";
const LAWN_TREATMENT_ROUNDS = [1, 2, 3, 4, 5, 6, 7];
const STATUS_ORDER = ["Scheduled", "On My Way", "Started", "Completed"];
const WEEDLESS_CONFIG = window.WEEDLESS_CONFIG || {};

const smsState = {
  enabled: false,
};

const syncState = {
  mode: "local",
  live: false,
  error: "",
  provider: null,
  saveTimer: null,
  applyingRemote: false,
  rowId: WEEDLESS_CONFIG.supabase?.stateRowId || "weedless-main",
};

const sampleCustomers = [
  {
    id: crypto.randomUUID(),
    name: "Sarah Thompson",
    phone: "918-555-1234",
    address: "123 Main St",
    notes: "Prefers early windows.",
  },
  {
    id: crypto.randomUUID(),
    name: "Mike Davis",
    phone: "918-555-4455",
    address: "456 Oak Dr",
    notes: "Gate code is 4621.",
  },
  {
    id: crypto.randomUUID(),
    name: "Linda Carter",
    phone: "918-555-7788",
    address: "789 Pine Ave",
    notes: "Dog in backyard.",
  },
];

const state = loadInitialState();
const refs = {
  headerDate: document.getElementById("headerDate"),
  smsStatus: document.getElementById("smsStatus"),
  syncStatus: document.getElementById("syncStatus"),
  tabButtons: [...document.querySelectorAll(".tab-button")],
  views: [...document.querySelectorAll(".view")],
  todayJobs: document.getElementById("todayJobs"),
  dashboardSummary: document.getElementById("dashboardSummary"),
  todayJobForm: document.getElementById("todayJobForm"),
  todayJobFormTitle: document.getElementById("todayJobFormTitle"),
  openTodayJobFormBtn: document.getElementById("openTodayJobFormBtn"),
  exportCompletedBtn: document.getElementById("exportCompletedBtn"),
  todayJobId: document.getElementById("todayJobId"),
  todayJobCustomer: document.getElementById("todayJobCustomer"),
  todayJobServiceType: document.getElementById("todayJobServiceType"),
  todayJobRoundField: document.getElementById("todayJobRoundField"),
  todayJobServiceRound: document.getElementById("todayJobServiceRound"),
  tomorrowJobs: document.getElementById("tomorrowJobs"),
  messageList: document.getElementById("messageList"),
  customerList: document.getElementById("customerList"),
  planningDate: document.getElementById("planningDate"),
  jobCustomer: document.getElementById("jobCustomer"),
  jobServiceType: document.getElementById("jobServiceType"),
  jobRoundField: document.getElementById("jobRoundField"),
  jobServiceRound: document.getElementById("jobServiceRound"),
  jobForm: document.getElementById("jobForm"),
  customerForm: document.getElementById("customerForm"),
  customerFormTitle: document.getElementById("customerFormTitle"),
  customerId: document.getElementById("customerId"),
  cancelCustomerEditBtn: document.getElementById("cancelCustomerEditBtn"),
  cancelTodayJobEditBtn: document.getElementById("cancelTodayJobEditBtn"),
  inspectionForm: document.getElementById("inspectionForm"),
  inspectionFormTitle: document.getElementById("inspectionFormTitle"),
  inspectionId: document.getElementById("inspectionId"),
  inspectionCustomer: document.getElementById("inspectionCustomer"),
  inspectionJob: document.getElementById("inspectionJob"),
  inspectionList: document.getElementById("inspectionList"),
  cancelInspectionEditBtn: document.getElementById("cancelInspectionEditBtn"),
};

init().catch((error) => {
  console.error(error);
  showToast("App startup hit an error");
});

async function init() {
  renderHeaderDate();
  populateServiceOptions();
  wireEvents();
  syncDashboardFromToday();
  renderAll();
  refreshSmsStatus();
  await initializeSync();
  registerServiceWorker();
}

function loadInitialState() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) {
    return migrateState(JSON.parse(saved));
  }

  const today = formatDateKey(new Date());
  const tomorrowDate = new Date();
  tomorrowDate.setDate(tomorrowDate.getDate() + 1);
  const tomorrow = formatDateKey(tomorrowDate);
  const seededJobs = seedTodayJobs(sampleCustomers, today);

  const seededState = {
    customers: sampleCustomers,
    schedules: {
      [today]: seededJobs,
      [tomorrow]: [],
    },
    inspections: [],
    ui: {
      activeView: "dashboard",
      scheduleDate: tomorrow,
      editingCustomerId: null,
    },
  };

  persistLocalState(seededState);
  return seededState;
}

async function initializeSync() {
  const supabaseConfig = WEEDLESS_CONFIG.supabase;
  if (!supabaseConfig?.url || !supabaseConfig?.anonKey) {
    renderSyncStatus();
    return;
  }

  try {
    const { createClient } = await import("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm");
    const client = createClient(supabaseConfig.url, supabaseConfig.anonKey);
    syncState.provider = {
      client,
      channel: null,
    };

    const { data, error } = await client
      .from("app_state")
      .select("payload")
      .eq("id", syncState.rowId)
      .maybeSingle();

    if (error) throw error;

    if (data?.payload) {
      applyRemoteState(data.payload);
    } else {
      await pushRemoteState();
    }

    syncState.mode = "supabase";
    syncState.error = "";
    subscribeToRemoteState();
  } catch (error) {
    console.error("Supabase sync unavailable:", error);
    syncState.mode = "local";
    syncState.live = false;
    syncState.error = "cloud unavailable";
    renderSyncStatus();
  }
}

function subscribeToRemoteState() {
  if (!syncState.provider) return;
  const { client } = syncState.provider;

  syncState.provider.channel = client
    .channel("weedless-scheduler-state")
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "app_state",
        filter: `id=eq.${syncState.rowId}`,
      },
      (payload) => {
        const remotePayload = payload.new?.payload;
        if (!remotePayload) return;
        applyRemoteState(remotePayload);
      },
    )
    .subscribe((status) => {
      syncState.live = status === "SUBSCRIBED";
      syncState.error = status === "SUBSCRIBED" ? "" : syncState.error;
      renderSyncStatus();
    });

  renderSyncStatus();
}

function applyRemoteState(remotePayload) {
  const nextState = migrateState(remotePayload);
  if (serializeState(nextState) === serializeState(state)) return;

  syncState.applyingRemote = true;
  state.customers = deepClone(nextState.customers);
  state.schedules = deepClone(nextState.schedules);
  state.ui = {
    ...state.ui,
    ...deepClone(nextState.ui),
  };
  persistLocalState(state);
  syncState.applyingRemote = false;
  renderAll();
}

function seedTodayJobs(customers, dateKey) {
  return [
    buildJob(customers[0], LAWN_TREATMENT_SERVICE, 60, 1, "08:00", "09:00", dateKey, 1),
    buildJob(customers[1], "Irrigation Repair", 90, 2, "09:30", "11:00", dateKey),
    buildJob(customers[2], "Aeration", 75, 3, "11:30", "12:45", dateKey),
  ];
}

function buildJob(
  customer,
  serviceType,
  estimatedDuration,
  order,
  windowStart,
  windowEnd,
  dateKey,
  serviceRound = null,
  extras = {},
) {
  return {
    id: crypto.randomUUID(),
    customerId: customer.id,
    customerName: customer.name,
    phone: customer.phone,
    address: customer.address,
    serviceType,
    serviceRound: normalizeServiceRound(serviceType, serviceRound),
    estimatedDuration,
    order,
    timeWindowStart: windowStart,
    timeWindowEnd: windowEnd,
    timeWindow: `${formatTime(windowStart)}-${formatTime(windowEnd)}`,
    status: "Scheduled",
    date: dateKey,
    onMyWayTime: null,
    startTime: null,
    completedTime: null,
    projectId: extras.projectId || crypto.randomUUID(),
    projectName: extras.projectName || "",
    assignedTo: extras.assignedTo || "",
    notes: extras.notes || "",
  };
}

function wireEvents() {
  refs.tabButtons.forEach((button) => {
    button.addEventListener("click", () => setActiveView(button.dataset.view));
  });

  refs.jobForm.addEventListener("submit", handleAddJob);
  refs.todayJobForm.addEventListener("submit", handleSaveTodayJob);
  refs.customerForm.addEventListener("submit", handleSaveCustomer);
  refs.inspectionForm.addEventListener("submit", handleSaveInspection);
  refs.cancelCustomerEditBtn.addEventListener("click", resetCustomerForm);
  refs.cancelTodayJobEditBtn.addEventListener("click", closeTodayJobForm);
  refs.cancelInspectionEditBtn.addEventListener("click", resetInspectionForm);
  refs.openTodayJobFormBtn.addEventListener("click", openTodayJobFormForCreate);
  refs.exportCompletedBtn.addEventListener("click", exportCompletedJobs);
  refs.jobServiceType.addEventListener("change", syncRoundFieldVisibility);
  refs.todayJobServiceType.addEventListener("change", syncTodayRoundFieldVisibility);
  refs.planningDate.addEventListener("change", handlePlanningDateChange);
  refs.inspectionJob.addEventListener("change", handleInspectionJobSelection);
  refs.inspectionCustomer.addEventListener("change", syncInspectionCustomerMode);
  ["change", "input"].forEach((eventName) => {
    document.getElementById("jobDuration").addEventListener(eventName, syncTomorrowEndTime);
    document.getElementById("jobTimeStart").addEventListener(eventName, syncTomorrowEndTime);
    document.getElementById("todayJobDuration").addEventListener(eventName, syncTodayEndTime);
    document.getElementById("todayJobTimeStart").addEventListener(eventName, syncTodayEndTime);
  });

  document.getElementById("autoAssignBtn").addEventListener("click", autoAssignTomorrowWindows);
  document.getElementById("generateMessagesBtn").addEventListener("click", renderMessages);
  document.getElementById("copyAllMessagesBtn").addEventListener("click", copyAllMessages);
  document.getElementById("clearTomorrowBtn").addEventListener("click", clearTomorrow);
}

function renderAll() {
  setActiveView(state.ui.activeView, false);
  refs.planningDate.value = getPlanningDateKey();
  renderCustomerOptions();
  renderInspectionOptions();
  syncInspectionCustomerMode();
  syncRoundFieldVisibility();
  syncTodayRoundFieldVisibility();
  syncTomorrowEndTime();
  syncTodayEndTime();
  renderSmsStatus();
  renderSyncStatus();
  renderTodayJobs();
  renderTomorrowJobs();
  renderCustomers();
  renderInspections();
  renderMessages();
  if (!refs.todayJobId.value) {
    resetTodayJobForm();
  }
  if (!refs.inspectionId.value) {
    resetInspectionForm();
  }
}

function setActiveView(viewName, persist = true) {
  state.ui.activeView = viewName;
  refs.tabButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.view === viewName);
  });
  refs.views.forEach((view) => {
    view.classList.toggle("active", view.dataset.view === viewName);
  });
  if (persist) saveState();
}

function renderHeaderDate() {
  const now = new Date();
  refs.headerDate.textContent = now.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function renderSmsStatus() {
  refs.smsStatus.textContent = smsState.enabled ? "Twilio SMS live" : "SMS fallback mode";
  refs.smsStatus.classList.toggle("live", smsState.enabled);
}

function renderSyncStatus() {
  if (!refs.syncStatus) return;

  if (syncState.mode === "supabase" && syncState.live) {
    refs.syncStatus.textContent = "Cloud sync live";
    refs.syncStatus.classList.add("live");
    return;
  }

  refs.syncStatus.classList.remove("live");
  if (syncState.mode === "supabase") {
    refs.syncStatus.textContent = syncState.error ? `Cloud sync: ${syncState.error}` : "Cloud sync connecting";
    return;
  }

  refs.syncStatus.textContent = "Local-only mode";
}

function populateServiceOptions() {
  refs.jobServiceType.innerHTML = SERVICES.map((service) => `<option value="${service}">${service}</option>`).join("");
  refs.todayJobServiceType.innerHTML = SERVICES.map((service) => `<option value="${service}">${service}</option>`).join("");
}

function renderCustomerOptions() {
  const customers = [...state.customers].sort((a, b) => a.name.localeCompare(b.name));
  const standardOptions = customers
    .map((customer) => `<option value="${customer.id}">${customer.name} - ${customer.address}</option>`)
    .join("");
  const inspectionOptions = [
    '<option value="__new__">Add New Customer</option>',
    ...customers.map((customer) => `<option value="${customer.id}">${customer.name} - ${customer.address}</option>`),
  ].join("");
  refs.jobCustomer.innerHTML = standardOptions;
  refs.todayJobCustomer.innerHTML = standardOptions;
  refs.inspectionCustomer.innerHTML = inspectionOptions;
}

function renderInspectionOptions() {
  const irrigationJobs = getAllJobs()
    .filter((job) => isIrrigationService(job.serviceType))
    .sort((a, b) => `${a.date}-${String(a.order).padStart(3, "0")}`.localeCompare(`${b.date}-${String(b.order).padStart(3, "0")}`));

  refs.inspectionJob.innerHTML = [
    '<option value="">No linked job</option>',
    ...irrigationJobs.map((job) => `<option value="${job.id}">${job.date} | ${job.customerName} | ${formatServiceLabel(job)}</option>`),
  ].join("");
}

function syncInspectionCustomerMode() {
  const isNewCustomer = refs.inspectionCustomer.value === "__new__";

  [
    "inspectionNewCustomerNameField",
    "inspectionNewCustomerPhoneField",
    "inspectionNewCustomerAddressField",
    "inspectionNewCustomerNotesField",
  ].forEach((id) => {
    const field = document.getElementById(id);
    field.hidden = !isNewCustomer;
    field.style.display = isNewCustomer ? "" : "none";
  });
}

function syncRoundFieldVisibility() {
  const isLawnTreatment = refs.jobServiceType.value === LAWN_TREATMENT_SERVICE;
  refs.jobRoundField.hidden = !isLawnTreatment;
  refs.jobRoundField.style.display = isLawnTreatment ? "" : "none";
  refs.jobRoundField.setAttribute("aria-hidden", String(!isLawnTreatment));
  refs.jobServiceRound.disabled = !isLawnTreatment;
  if (!isLawnTreatment) {
    refs.jobServiceRound.value = "1";
  }
}

function syncTodayRoundFieldVisibility() {
  const isLawnTreatment = refs.todayJobServiceType.value === LAWN_TREATMENT_SERVICE;
  refs.todayJobRoundField.hidden = !isLawnTreatment;
  refs.todayJobRoundField.style.display = isLawnTreatment ? "" : "none";
  refs.todayJobRoundField.setAttribute("aria-hidden", String(!isLawnTreatment));
  refs.todayJobServiceRound.disabled = !isLawnTreatment;
  if (!isLawnTreatment) {
    refs.todayJobServiceRound.value = "1";
  }
}

function syncTomorrowEndTime() {
  const start = document.getElementById("jobTimeStart").value || "08:00";
  document.getElementById("jobTimeEnd").value = addMinutes(start, 120);
}

function syncTodayEndTime() {
  const start = document.getElementById("todayJobTimeStart").value || "08:00";
  document.getElementById("todayJobTimeEnd").value = addMinutes(start, 120);
}

function renderTodayJobs() {
  const todayJobs = getJobsForDate(getTodayKey());
  refs.todayJobs.innerHTML = "";
  refs.dashboardSummary.innerHTML = "";

  const nextJob = todayJobs.find((job) => job.status !== "Completed");
  const summaryCards = [
    { label: "Total Jobs", value: todayJobs.length },
    { label: "Completed", value: todayJobs.filter((job) => job.status === "Completed").length },
    { label: "Next Start", value: nextJob ? formatTime(nextJob.timeWindowStart) : "--" },
    { label: "Target Start", value: "8:00 AM" },
  ];

  refs.dashboardSummary.innerHTML = summaryCards
    .map((card) => `<div class="summary-card"><span>${card.label}</span><strong>${escapeHtml(String(card.value))}</strong></div>`)
    .join("");

  if (!todayJobs.length) {
    refs.todayJobs.innerHTML = '<div class="empty-state">No jobs scheduled for today.</div>';
    return;
  }

  todayJobs.forEach((job) => {
    const card = createJobCard(job, true, job.id === nextJob?.id);
    const editGroup = document.createElement("div");
    editGroup.className = "job-actions";
    editGroup.innerHTML = `
      <button class="secondary" data-action="edit-today">Edit</button>
      <button class="secondary" data-action="move-up-today">Move Up</button>
      <button class="secondary" data-action="move-down-today">Move Down</button>
      <button class="ghost" data-action="continue-tomorrow">Continue Tomorrow</button>
      <button class="warn" data-action="delete-today">Delete</button>
    `;
    editGroup.addEventListener("click", (event) => handleTodayAdjustAction(event, job.id));
    card.append(editGroup);
    refs.todayJobs.append(card);
  });
}

function renderTomorrowJobs() {
  const tomorrowJobs = getJobsForDate(getPlanningDateKey());
  refs.tomorrowJobs.innerHTML = "";

  if (!tomorrowJobs.length) {
    refs.tomorrowJobs.innerHTML = '<div class="empty-state">Add jobs for this date here.</div>';
    return;
  }

  tomorrowJobs.forEach((job) => {
    const card = createJobCard(job, false, false);
    const editGroup = document.createElement("div");
    editGroup.className = "job-actions";
    editGroup.innerHTML = `
      <button class="secondary" data-action="move-up">Move Up</button>
      <button class="secondary" data-action="move-down">Move Down</button>
      <button class="ghost" data-action="continue-tomorrow">Continue Tomorrow</button>
      <button class="ghost" data-action="copy-night-message">Copy Message</button>
      <button class="warn" data-action="delete-job">Delete</button>
    `;
    editGroup.addEventListener("click", (event) => handleTomorrowJobAction(event, job.id));
    card.append(editGroup);
    refs.tomorrowJobs.append(card);
  });
}

function renderCustomers() {
  refs.customerList.innerHTML = "";
  if (!state.customers.length) {
    refs.customerList.innerHTML = '<div class="empty-state">No customers added yet.</div>';
    return;
  }

  [...state.customers]
    .sort((a, b) => a.name.localeCompare(b.name))
    .forEach((customer) => {
      const card = document.createElement("article");
      card.className = "customer-card";
      card.innerHTML = `
        <div class="customer-header">
          <div>
            <h3>${escapeHtml(customer.name)}</h3>
            <p>${escapeHtml(customer.phone)}</p>
          </div>
        </div>
        <div class="customer-body">
          <p>${escapeHtml(customer.address)}</p>
          <p>${escapeHtml(customer.notes || "No notes")}</p>
        </div>
        <div class="customer-actions">
          <button class="secondary" data-action="edit">Edit</button>
          <button class="warn" data-action="delete">Delete</button>
        </div>
      `;

      card.querySelector('[data-action="edit"]').addEventListener("click", () => startCustomerEdit(customer.id));
      card.querySelector('[data-action="delete"]').addEventListener("click", () => deleteCustomer(customer.id));
      refs.customerList.append(card);
    });
}

function renderInspections() {
  refs.inspectionList.innerHTML = "";
  const inspections = [...state.inspections].sort((a, b) => `${b.inspectionDate}-${b.createdAt}`.localeCompare(`${a.inspectionDate}-${a.createdAt}`));

  if (!inspections.length) {
    refs.inspectionList.innerHTML = '<div class="empty-state">No irrigation inspections saved yet.</div>';
    return;
  }

  inspections.forEach((inspection) => {
    const customer = state.customers.find((entry) => entry.id === inspection.customerId);
    const linkedJob = inspection.jobId ? findJobById(inspection.jobId) : null;
    const card = document.createElement("article");
    card.className = "inspection-card";
    card.innerHTML = `
      <div class="customer-header">
        <div>
          <h3>${escapeHtml(customer?.name || inspection.customerName || "Unknown Customer")}</h3>
          <p>${escapeHtml(formatInspectionTitle(inspection, linkedJob))}</p>
        </div>
      </div>
      <div class="inspection-facts">
        <span>Draft Date: ${escapeHtml(inspection.draftDate || "Not set")}</span>
        <span>Zones: ${escapeHtml(String(inspection.zoneCount || 0))}</span>
        <span>Issue Zones: ${escapeHtml(inspection.issueZones || "None listed")}</span>
        <span>Broken Heads: ${escapeHtml(String(inspection.brokenHeads || 0))}</span>
        <span>Controller: ${escapeHtml(inspection.controllerType || "Not listed")}</span>
        <span>Location: ${escapeHtml(inspection.controllerLocation || "Not listed")}</span>
        <span>Flags: ${escapeHtml(formatInspectionFlags(inspection))}</span>
      </div>
      <div class="inspection-notes">${escapeHtml(buildInspectionNotesSummary(inspection))}</div>
      <div class="job-actions">
        <button class="secondary" data-action="edit">Edit</button>
        <button class="ghost" data-action="open-report">Open Report</button>
        <button class="ghost" data-action="draft-job">Create Draft Job</button>
        <button class="ghost" data-action="copy">Copy Summary</button>
        <button class="warn" data-action="delete">Delete</button>
      </div>
    `;

    card.querySelector('[data-action="edit"]').addEventListener("click", () => startInspectionEdit(inspection.id));
    card.querySelector('[data-action="open-report"]').addEventListener("click", () => openInspectionReport(inspection.id));
    card.querySelector('[data-action="draft-job"]').addEventListener("click", () => createDraftJobFromInspection(inspection.id));
    card.querySelector('[data-action="copy"]').addEventListener("click", () => copyText(buildInspectionCopySummary(inspection), "Inspection summary copied"));
    card.querySelector('[data-action="delete"]').addEventListener("click", () => deleteInspection(inspection.id));
    refs.inspectionList.append(card);
  });
}

function renderMessages() {
  const tomorrowJobs = getJobsForDate(getPlanningDateKey());
  if (!tomorrowJobs.length) {
    refs.messageList.className = "message-list empty-state";
    refs.messageList.textContent = "Generate messages after adding jobs for the selected date.";
    return;
  }

  refs.messageList.className = "message-list";
  refs.messageList.innerHTML = "";
  tomorrowJobs.forEach((job) => {
    const message = buildNightBeforeMessage(job);
    const card = document.createElement("article");
    card.className = "message-card";
    card.innerHTML = `
      <h4>${escapeHtml(getFirstName(job.customerName))}</h4>
      <div class="message-body"><pre>${escapeHtml(message)}</pre></div>
      <div class="message-actions">
        <button class="secondary" data-action="send">Send Text</button>
        <button data-action="copy">Copy Message</button>
      </div>
    `;
    card.querySelector('[data-action="send"]').addEventListener("click", () => sendCustomerMessage(job, message, "Night-before message sent", "Night-before message copied"));
    card.querySelector('[data-action="copy"]').addEventListener("click", () => copyText(message, "Night-before message copied"));
    refs.messageList.append(card);
  });
}

function createJobCard(job, includeFieldActions, isNextJob) {
  const template = document.getElementById("jobCardTemplate");
  const card = template.content.firstElementChild.cloneNode(true);
  card.classList.toggle("next-job", isNextJob);
  card.querySelector(".job-order").textContent = `Stop #${job.order}${isNextJob ? " - Next Job" : ""}`;
  card.querySelector(".job-customer").textContent = job.customerName;
  card.querySelector(".job-service").textContent = formatServiceLabel(job);
  card.querySelector(".job-address").textContent = job.address;
  const detailLine = buildJobDetailLine(job);
  if (detailLine) {
    const detail = document.createElement("p");
    detail.className = "job-detail";
    detail.textContent = detailLine;
    card.querySelector(".job-address").insertAdjacentElement("afterend", detail);
  }

  const statusPill = card.querySelector(".status-pill");
  statusPill.textContent = job.status;
  statusPill.classList.add(`status-${job.status.toLowerCase().replace(/\s+/g, "-")}`);

  const meta = card.querySelector(".job-meta");
  [
    `${job.timeWindow}`,
    `${job.estimatedDuration} min`,
    timestampSummary(job),
  ]
    .filter(Boolean)
    .forEach((item) => {
      const chip = document.createElement("span");
      chip.className = "meta-chip";
      chip.textContent = item;
      meta.append(chip);
    });

  const actions = card.querySelector(".job-actions");
  if (includeFieldActions) {
    actions.innerHTML = `
      <button data-action="navigate">Navigate</button>
      <button class="secondary" data-action="on-my-way">On My Way</button>
      <button class="secondary" data-action="started">Started</button>
      <button class="secondary" data-action="completed">Completed</button>
      ${isIrrigationService(job.serviceType) ? '<button class="ghost" data-action="inspection">Inspection</button>' : ""}
      <button class="warn" data-action="running-late">Running Late</button>
    `;
    actions.addEventListener("click", (event) => {
      void handleTodayAction(event, job.id);
    });
  } else {
    actions.remove();
  }

  return card;
}

async function handleTodayAction(event, jobId) {
  const action = event.target.dataset.action;
  if (!action) return;

  const todayKey = getTodayKey();
  const jobs = getJobsForDate(todayKey);
  const job = jobs.find((entry) => entry.id === jobId);
  if (!job) return;

  if (action === "navigate") {
    window.open(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(job.address)}`, "_blank");
    return;
  }

  if (action === "on-my-way") {
    job.status = "On My Way";
    job.onMyWayTime = new Date().toISOString();
    const eta = job.timeWindow.split("-")[0];
    const message = `Hey ${getFirstName(job.customerName)}, this is Weedless Lawn Care & Irrigation. I'm headed your way now and should be there around ${eta}.`;
    await sendCustomerMessage(job, message, "On My Way text sent", "On My Way message copied");
  }

  if (action === "started") {
    job.status = "Started";
    job.startTime = new Date().toISOString();
    showToast("Job marked started");
  }

  if (action === "completed") {
    job.status = "Completed";
    job.completedTime = new Date().toISOString();
    showToast("Job marked completed");
  }

  if (action === "running-late") {
    const updatedWindow = suggestNextWindow(job, jobs);
    job.timeWindowStart = updatedWindow.start;
    job.timeWindowEnd = updatedWindow.end;
    job.timeWindow = `${formatTime(updatedWindow.start)}-${formatTime(updatedWindow.end)}`;
    const message = `Hey ${getFirstName(job.customerName)}, I'm running a little behind today. My updated arrival window is ${job.timeWindow}. Thanks for your patience.`;
    await sendCustomerMessage(job, message, "Running late text sent", "Running late message copied");
  }

  if (action === "inspection") {
    openInspectionFormForJob(job);
    return;
  }

  sortJobs(todayKey);
  saveState();
  renderTodayJobs();
}

function handleTomorrowJobAction(event, jobId) {
  const action = event.target.dataset.action;
  if (!action) return;
  const planningKey = getPlanningDateKey();
  const jobs = getJobsForDate(planningKey);
  const index = jobs.findIndex((job) => job.id === jobId);
  if (index === -1) return;

  if (action === "move-up" && index > 0) {
    [jobs[index - 1], jobs[index]] = [jobs[index], jobs[index - 1]];
  }

  if (action === "move-down" && index < jobs.length - 1) {
    [jobs[index + 1], jobs[index]] = [jobs[index], jobs[index + 1]];
  }

  if (action === "delete-job") {
    jobs.splice(index, 1);
  }

  if (action === "copy-night-message") {
    void copyText(buildNightBeforeMessage(jobs[index]), "Night-before message copied");
  }

  if (action === "continue-tomorrow") {
    continueJobToTomorrow(jobs[index]);
    return;
  }

  jobs.forEach((job, order) => {
    job.order = order + 1;
  });
  saveState();
  renderTomorrowJobs();
  renderMessages();
}

function handleAddJob(event) {
  event.preventDefault();
  const customer = state.customers.find((entry) => entry.id === refs.jobCustomer.value);
  if (!customer) return;

  const order = Number(document.getElementById("jobOrder").value);
  const serviceType = refs.jobServiceType.value;
  const serviceRound = serviceType === LAWN_TREATMENT_SERVICE ? Number(refs.jobServiceRound.value) : null;
  const duration = Number(document.getElementById("jobDuration").value);
  const start = document.getElementById("jobTimeStart").value || "08:00";
  const end = addMinutes(start, 120);
  const projectName = document.getElementById("jobProjectName").value.trim();
  const assignedTo = document.getElementById("jobAssignedTo").value.trim();
  const notes = document.getElementById("jobNotes").value.trim();
  const planningKey = getPlanningDateKey();
  const jobs = getJobsForDate(planningKey);

  const job = buildJob(customer, serviceType, duration, order, start, end, planningKey, serviceRound, {
    projectName,
    assignedTo,
    notes,
  });
  jobs.push(job);
  sortJobs(planningKey);
  reindexJobs(planningKey);
  saveState();
  refs.jobForm.reset();
  document.getElementById("jobDuration").value = 60;
  document.getElementById("jobOrder").value = jobs.length + 1;
  document.getElementById("jobTimeStart").value = "08:00";
  document.getElementById("jobTimeEnd").value = "09:00";
  refs.jobServiceRound.value = "1";
  syncRoundFieldVisibility();
  syncTomorrowEndTime();
  renderTomorrowJobs();
  renderMessages();
  showToast("Job added to schedule");
}

function handleSaveTodayJob(event) {
  event.preventDefault();
  const customer = state.customers.find((entry) => entry.id === refs.todayJobCustomer.value);
  if (!customer) return;

  const todayKey = getTodayKey();
  const jobs = getJobsForDate(todayKey);
  const existingId = refs.todayJobId.value;
  const serviceType = refs.todayJobServiceType.value;
  const serviceRound = serviceType === LAWN_TREATMENT_SERVICE ? Number(refs.todayJobServiceRound.value) : null;
  const duration = Number(document.getElementById("todayJobDuration").value);
  const order = Number(document.getElementById("todayJobOrder").value);
  const start = document.getElementById("todayJobTimeStart").value || "08:00";
  const end = addMinutes(start, 120);
  const projectName = document.getElementById("todayJobProjectName").value.trim();
  const assignedTo = document.getElementById("todayJobAssignedTo").value.trim();
  const notes = document.getElementById("todayJobNotes").value.trim();

  if (existingId) {
    const job = jobs.find((entry) => entry.id === existingId);
    if (!job) return;
    Object.assign(job, {
      customerId: customer.id,
      customerName: customer.name,
      phone: customer.phone,
      address: customer.address,
      serviceType,
      serviceRound: normalizeServiceRound(serviceType, serviceRound),
      estimatedDuration: duration,
      order,
      timeWindowStart: start,
      timeWindowEnd: end,
      timeWindow: `${formatTime(start)}-${formatTime(end)}`,
      projectName,
      assignedTo,
      notes,
    });
    showToast("Today's job updated");
  } else {
    jobs.push(buildJob(customer, serviceType, duration, order, start, end, todayKey, serviceRound, {
      projectName,
      assignedTo,
      notes,
    }));
    showToast("Today's job added");
  }

  sortJobs(todayKey);
  reindexJobs(todayKey);
  saveState();
  closeTodayJobForm();
  renderTodayJobs();
}

function handleSaveCustomer(event) {
  event.preventDefault();
  const id = refs.customerId.value;
  const payload = {
    name: document.getElementById("customerName").value.trim(),
    phone: document.getElementById("customerPhone").value.trim(),
    address: document.getElementById("customerAddress").value.trim(),
    notes: document.getElementById("customerNotes").value.trim(),
  };

  if (id) {
    const customer = state.customers.find((entry) => entry.id === id);
    Object.assign(customer, payload);
    syncCustomerReferences(customer);
    showToast("Customer updated");
  } else {
    state.customers.push({ id: crypto.randomUUID(), ...payload });
    showToast("Customer added");
  }

  saveState();
  resetCustomerForm();
  renderCustomerOptions();
  renderCustomers();
  renderTodayJobs();
  renderTomorrowJobs();
  renderMessages();
}

function handleTodayAdjustAction(event, jobId) {
  const action = event.target.dataset.action;
  if (!action) return;

  const todayKey = getTodayKey();
  const jobs = getJobsForDate(todayKey);
  const index = jobs.findIndex((job) => job.id === jobId);
  if (index === -1) return;

  if (action === "edit-today") {
    startTodayJobEdit(jobId);
    return;
  }

  if (action === "move-up-today" && index > 0) {
    [jobs[index - 1], jobs[index]] = [jobs[index], jobs[index - 1]];
  }

  if (action === "move-down-today" && index < jobs.length - 1) {
    [jobs[index + 1], jobs[index]] = [jobs[index], jobs[index + 1]];
  }

  if (action === "delete-today") {
    jobs.splice(index, 1);
  }

  if (action === "continue-tomorrow") {
    continueJobToTomorrow(jobs[index]);
    return;
  }

  reindexJobs(todayKey);
  saveState();
  if (action === "delete-today") {
    resetTodayJobForm();
    showToast("Today's job deleted");
  }
  renderTodayJobs();
}

function startCustomerEdit(customerId) {
  const customer = state.customers.find((entry) => entry.id === customerId);
  if (!customer) return;
  refs.customerFormTitle.textContent = "Edit Customer";
  refs.customerId.value = customer.id;
  document.getElementById("customerName").value = customer.name;
  document.getElementById("customerPhone").value = customer.phone;
  document.getElementById("customerAddress").value = customer.address;
  document.getElementById("customerNotes").value = customer.notes || "";
}

function startTodayJobEdit(jobId) {
  const job = getJobsForDate(getTodayKey()).find((entry) => entry.id === jobId);
  if (!job) return;

  openTodayJobForm();
  refs.todayJobFormTitle.textContent = "Edit Job Today";
  refs.todayJobId.value = job.id;
  refs.todayJobCustomer.value = job.customerId;
  refs.todayJobServiceType.value = job.serviceType;
  refs.todayJobServiceRound.value = String(normalizeServiceRound(job.serviceType, job.serviceRound) || 1);
  document.getElementById("todayJobProjectName").value = job.projectName || "";
  document.getElementById("todayJobAssignedTo").value = job.assignedTo || "";
  document.getElementById("todayJobDuration").value = job.estimatedDuration;
  document.getElementById("todayJobOrder").value = job.order;
  document.getElementById("todayJobTimeStart").value = job.timeWindowStart;
  document.getElementById("todayJobTimeEnd").value = job.timeWindowEnd;
  document.getElementById("todayJobNotes").value = job.notes || "";
  syncTodayRoundFieldVisibility();
  syncTodayEndTime();
  refs.todayJobForm.scrollIntoView({ behavior: "smooth", block: "start" });
}

function resetCustomerForm() {
  refs.customerForm.reset();
  refs.customerId.value = "";
  refs.customerFormTitle.textContent = "Add Customer";
}

function handleSaveInspection(event) {
  event.preventDefault();
  const customer = getInspectionCustomerFromForm();
  if (!customer) return;

  const linkedJob = refs.inspectionJob.value ? findJobById(refs.inspectionJob.value) : null;
  const inspectionId = refs.inspectionId.value;
  const payload = {
    customerId: customer.id,
    customerName: customer.name,
    jobId: linkedJob?.id || "",
    jobDate: linkedJob?.date || "",
    inspectionDate: document.getElementById("inspectionDate").value || formatDateKey(new Date()),
    draftDate: document.getElementById("inspectionDraftDate").value || getPlanningDateKey(),
    zoneCount: Number(document.getElementById("inspectionZoneCount").value || 0),
    issueZones: document.getElementById("inspectionIssueZones").value.trim(),
    brokenHeads: Number(document.getElementById("inspectionBrokenHeads").value || 0),
    headTypes: document.getElementById("inspectionHeadTypes").value.trim(),
    controllerType: document.getElementById("inspectionControllerType").value.trim(),
    controllerLocation: document.getElementById("inspectionControllerLocation").value.trim(),
    leakDetected: document.getElementById("inspectionLeakDetected").checked,
    valveIssue: document.getElementById("inspectionValveIssue").checked,
    wiringIssue: document.getElementById("inspectionWiringIssue").checked,
    controllerIssue: document.getElementById("inspectionControllerIssue").checked,
    repairsNeeded: document.getElementById("inspectionRepairsNeeded").value.trim(),
    materialsNeeded: document.getElementById("inspectionMaterialsNeeded").value.trim(),
    notes: document.getElementById("inspectionNotes").value.trim(),
  };

  if (inspectionId) {
    const inspection = state.inspections.find((entry) => entry.id === inspectionId);
    if (!inspection) return;
    Object.assign(inspection, payload, { updatedAt: new Date().toISOString() });
    showToast("Inspection updated");
  } else {
    state.inspections.push({
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...payload,
    });
    showToast("Inspection saved");
  }

  saveState();
  renderCustomerOptions();
  renderInspectionOptions();
  renderInspections();
  resetInspectionForm();
}

function resetTodayJobForm() {
  refs.todayJobForm.reset();
  refs.todayJobId.value = "";
  refs.todayJobFormTitle.textContent = "Add Job Today";
  document.getElementById("todayJobProjectName").value = "";
  document.getElementById("todayJobAssignedTo").value = "";
  document.getElementById("todayJobDuration").value = 60;
  document.getElementById("todayJobOrder").value = getJobsForDate(getTodayKey()).length + 1;
  document.getElementById("todayJobTimeStart").value = "08:00";
  document.getElementById("todayJobTimeEnd").value = "09:00";
  document.getElementById("todayJobNotes").value = "";
  refs.todayJobServiceRound.value = "1";
  syncTodayRoundFieldVisibility();
  syncTodayEndTime();
}

function resetInspectionForm() {
  refs.inspectionForm.reset();
  refs.inspectionId.value = "";
  refs.inspectionFormTitle.textContent = "New Inspection";
  refs.inspectionCustomer.value = "__new__";
  document.getElementById("inspectionDate").value = formatDateKey(new Date());
  document.getElementById("inspectionDraftDate").value = getPlanningDateKey();
  document.getElementById("inspectionZoneCount").value = 0;
  document.getElementById("inspectionBrokenHeads").value = 0;
  document.getElementById("inspectionNewCustomerName").value = "";
  document.getElementById("inspectionNewCustomerPhone").value = "";
  document.getElementById("inspectionNewCustomerAddress").value = "";
  document.getElementById("inspectionNewCustomerNotes").value = "";
  syncInspectionCustomerMode();
}

function openTodayJobForm() {
  refs.todayJobForm.hidden = false;
  refs.todayJobForm.removeAttribute("hidden");
  refs.todayJobForm.style.display = "";
}

function closeTodayJobForm(event) {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }
  resetTodayJobForm();
  refs.todayJobForm.hidden = true;
  refs.todayJobForm.setAttribute("hidden", "");
  refs.todayJobForm.style.display = "none";
}

function openTodayJobFormForCreate() {
  resetTodayJobForm();
  openTodayJobForm();
  refs.todayJobForm.scrollIntoView({ behavior: "smooth", block: "start" });
}

function openInspectionFormForJob(job) {
  setActiveView("inspections");
  resetInspectionForm();
  refs.inspectionCustomer.value = job.customerId;
  refs.inspectionJob.value = job.id;
  refs.inspectionFormTitle.textContent = `New Inspection for ${job.customerName}`;
  syncInspectionCustomerMode();
  refs.inspectionForm.scrollIntoView({ behavior: "smooth", block: "start" });
}

function startInspectionEdit(inspectionId) {
  const inspection = state.inspections.find((entry) => entry.id === inspectionId);
  if (!inspection) return;
  setActiveView("inspections");
  refs.inspectionFormTitle.textContent = "Edit Inspection";
  refs.inspectionId.value = inspection.id;
  refs.inspectionCustomer.value = state.customers.some((entry) => entry.id === inspection.customerId) ? inspection.customerId : "__new__";
  refs.inspectionJob.value = inspection.jobId || "";
  document.getElementById("inspectionDate").value = inspection.inspectionDate || formatDateKey(new Date());
  document.getElementById("inspectionDraftDate").value = inspection.draftDate || getPlanningDateKey();
  document.getElementById("inspectionZoneCount").value = inspection.zoneCount || 0;
  document.getElementById("inspectionIssueZones").value = inspection.issueZones || "";
  document.getElementById("inspectionBrokenHeads").value = inspection.brokenHeads || 0;
  document.getElementById("inspectionHeadTypes").value = inspection.headTypes || "";
  document.getElementById("inspectionControllerType").value = inspection.controllerType || "";
  document.getElementById("inspectionControllerLocation").value = inspection.controllerLocation || "";
  document.getElementById("inspectionLeakDetected").checked = Boolean(inspection.leakDetected);
  document.getElementById("inspectionValveIssue").checked = Boolean(inspection.valveIssue);
  document.getElementById("inspectionWiringIssue").checked = Boolean(inspection.wiringIssue);
  document.getElementById("inspectionControllerIssue").checked = Boolean(inspection.controllerIssue);
  document.getElementById("inspectionRepairsNeeded").value = inspection.repairsNeeded || "";
  document.getElementById("inspectionMaterialsNeeded").value = inspection.materialsNeeded || "";
  document.getElementById("inspectionNotes").value = inspection.notes || "";
  document.getElementById("inspectionNewCustomerName").value = inspection.customerName || "";
  document.getElementById("inspectionNewCustomerPhone").value = "";
  document.getElementById("inspectionNewCustomerAddress").value = "";
  document.getElementById("inspectionNewCustomerNotes").value = "";
  syncInspectionCustomerMode();
  refs.inspectionForm.scrollIntoView({ behavior: "smooth", block: "start" });
}

function deleteCustomer(customerId) {
  state.customers = state.customers.filter((entry) => entry.id !== customerId);
  Object.keys(state.schedules).forEach((dateKey) => {
    state.schedules[dateKey] = state.schedules[dateKey].filter((job) => job.customerId !== customerId);
  });
  state.inspections = state.inspections.filter((inspection) => inspection.customerId !== customerId);
  saveState();
  renderCustomerOptions();
  renderCustomers();
  renderInspections();
  renderTodayJobs();
  renderTomorrowJobs();
  renderMessages();
  showToast("Customer deleted");
}

function deleteInspection(inspectionId) {
  state.inspections = state.inspections.filter((entry) => entry.id !== inspectionId);
  saveState();
  renderInspections();
  resetInspectionForm();
  showToast("Inspection deleted");
}

function createDraftJobFromInspection(inspectionId) {
  const inspection = state.inspections.find((entry) => entry.id === inspectionId);
  if (!inspection) return;
  const customer = state.customers.find((entry) => entry.id === inspection.customerId);
  if (!customer) {
    showToast("Customer missing for inspection");
    return;
  }

  const linkedJob = inspection.jobId ? findJobById(inspection.jobId) : null;
  state.ui.scheduleDate = inspection.draftDate || getPlanningDateKey();
  refs.planningDate.value = state.ui.scheduleDate;
  setActiveView("schedule");
  refs.jobCustomer.value = customer.id;
  refs.jobServiceType.value = linkedJob?.serviceType || "Irrigation Repair";
  refs.jobServiceRound.value = "1";
  document.getElementById("jobProjectName").value = linkedJob?.projectName || `Inspection Follow-up - ${customer.name}`;
  document.getElementById("jobAssignedTo").value = linkedJob?.assignedTo || "";
  document.getElementById("jobDuration").value = linkedJob?.estimatedDuration || 120;
  document.getElementById("jobOrder").value = getJobsForDate(getPlanningDateKey()).length + 1;
  document.getElementById("jobTimeStart").value = linkedJob?.timeWindowStart || "08:00";
  document.getElementById("jobNotes").value = buildInspectionDraftNotes(inspection);
  syncRoundFieldVisibility();
  syncTomorrowEndTime();
  renderTomorrowJobs();
  renderMessages();
  refs.jobForm.scrollIntoView({ behavior: "smooth", block: "start" });
  saveState();
  showToast("Draft job filled from inspection");
}

function handleInspectionJobSelection() {
  const linkedJob = refs.inspectionJob.value ? findJobById(refs.inspectionJob.value) : null;
  if (!linkedJob) return;
  refs.inspectionCustomer.value = linkedJob.customerId;
  syncInspectionCustomerMode();
}

function handlePlanningDateChange() {
  state.ui.scheduleDate = refs.planningDate.value || getTomorrowKey();
  saveState();
  renderTomorrowJobs();
  renderMessages();
  document.getElementById("jobOrder").value = getJobsForDate(getPlanningDateKey()).length + 1;
}

function getInspectionCustomerFromForm() {
  if (refs.inspectionCustomer.value !== "__new__") {
    return state.customers.find((entry) => entry.id === refs.inspectionCustomer.value) || null;
  }

  const name = document.getElementById("inspectionNewCustomerName").value.trim();
  const phone = document.getElementById("inspectionNewCustomerPhone").value.trim();
  const address = document.getElementById("inspectionNewCustomerAddress").value.trim();
  const notes = document.getElementById("inspectionNewCustomerNotes").value.trim();

  if (!name || !phone || !address) {
    showToast("New customer name, phone, and address are required");
    return null;
  }

  const existingCustomer = state.customers.find((entry) =>
    entry.name.trim().toLowerCase() === name.toLowerCase() &&
    entry.address.trim().toLowerCase() === address.toLowerCase(),
  );

  if (existingCustomer) {
    refs.inspectionCustomer.value = existingCustomer.id;
    syncInspectionCustomerMode();
    return existingCustomer;
  }

  const customer = {
    id: crypto.randomUUID(),
    name,
    phone,
    address,
    notes,
  };
  state.customers.push(customer);
  refs.inspectionCustomer.value = customer.id;
  syncInspectionCustomerMode();
  showToast("New customer added from inspection");
  return customer;
}

function autoAssignTomorrowWindows() {
  const planningKey = getPlanningDateKey();
  const jobs = getJobsForDate(planningKey);
  let pointer = "08:00";
  jobs.forEach((job) => {
    job.timeWindowStart = pointer;
    pointer = addMinutes(pointer, job.estimatedDuration);
    job.timeWindowEnd = pointer;
    job.timeWindow = `${formatTime(job.timeWindowStart)}-${formatTime(job.timeWindowEnd)}`;
    pointer = addMinutes(pointer, 15);
  });
  saveState();
  renderTomorrowJobs();
  renderMessages();
  showToast("Schedule windows assigned");
}

function clearTomorrow() {
  state.schedules[getPlanningDateKey()] = [];
  saveState();
  renderTomorrowJobs();
  renderMessages();
  showToast("Schedule cleared");
}

function syncDashboardFromToday() {
  const todayJobs = getJobsForDate(getTodayKey());
  if (!todayJobs.length) {
    state.schedules[getTodayKey()] = [];
  }
  saveState();
}

function continueJobToTomorrow(job) {
  const tomorrowKey = getNextDateKey(job.date);
  const tomorrowJobs = getJobsForDate(tomorrowKey);
  const duplicate = tomorrowJobs.find((entry) =>
    entry.projectId === job.projectId &&
    entry.customerId === job.customerId &&
    entry.serviceType === job.serviceType &&
    entry.timeWindowStart === job.timeWindowStart,
  );

  if (duplicate) {
    showToast("That continued job is already on the next day");
    return;
  }

  const customer = state.customers.find((entry) => entry.id === job.customerId) || {
    id: job.customerId,
    name: job.customerName,
    phone: job.phone,
    address: job.address,
  };

  const continuedJob = buildJob(
    customer,
    job.serviceType,
    job.estimatedDuration,
    tomorrowJobs.length + 1,
    job.timeWindowStart,
    job.timeWindowEnd,
    tomorrowKey,
    job.serviceRound,
    {
      projectId: job.projectId,
      projectName: job.projectName,
      assignedTo: job.assignedTo,
      notes: job.notes,
    },
  );

  tomorrowJobs.push(continuedJob);
  sortJobs(tomorrowKey);
  reindexJobs(tomorrowKey);
  saveState();
  renderTomorrowJobs();
  renderMessages();
  showToast("Job continued into the next day");
}

function getJobsForDate(dateKey) {
  if (!state.schedules[dateKey]) state.schedules[dateKey] = [];
  return state.schedules[dateKey];
}

function getAllJobs() {
  return Object.values(state.schedules).flat();
}

function findJobById(jobId) {
  return getAllJobs().find((job) => job.id === jobId) || null;
}

function sortJobs(dateKey) {
  state.schedules[dateKey].sort((a, b) => a.order - b.order || STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status));
}

function reindexJobs(dateKey) {
  getJobsForDate(dateKey).forEach((job, index) => {
    job.order = index + 1;
  });
}

function renderMessagesText() {
  return getJobsForDate(getPlanningDateKey()).map(buildNightBeforeMessage).join("\n\n");
}

function copyAllMessages() {
  const text = renderMessagesText();
  if (!text) {
    showToast("No messages to copy");
    return;
  }
  void copyText(text, "All messages copied");
}

function buildNightBeforeMessage(job) {
  return `Hey ${getFirstName(job.customerName)}, this is Weedless Lawn Care & Irrigation. I've got you scheduled for ${formatLongDate(job.date)} with an arrival window of ${job.timeWindow} for ${formatServiceLabel(job)}. Thanks!`;
}

function buildJobDetailLine(job) {
  const details = [];
  if (job.projectName) details.push(`Project: ${job.projectName}`);
  if (job.assignedTo) details.push(`Crew: ${job.assignedTo}`);
  if (job.notes) details.push(`Notes: ${job.notes}`);
  return details.join(" | ");
}

function formatInspectionTitle(inspection, linkedJob) {
  const jobLabel = linkedJob ? formatServiceLabel(linkedJob) : "Standalone inspection";
  return `${inspection.inspectionDate} | ${jobLabel}`;
}

function formatInspectionFlags(inspection) {
  const flags = [];
  if (inspection.leakDetected) flags.push("Leak");
  if (inspection.valveIssue) flags.push("Valve");
  if (inspection.wiringIssue) flags.push("Wiring");
  if (inspection.controllerIssue) flags.push("Controller");
  return flags.length ? flags.join(", ") : "No flagged issues";
}

function buildInspectionNotesSummary(inspection) {
  const parts = [];
  if (inspection.repairsNeeded) parts.push(`Repairs Needed:\n${inspection.repairsNeeded}`);
  if (inspection.materialsNeeded) parts.push(`Materials Needed:\n${inspection.materialsNeeded}`);
  if (inspection.notes) parts.push(`Notes:\n${inspection.notes}`);
  return parts.join("\n\n") || "No inspection notes added yet.";
}

function buildInspectionCopySummary(inspection) {
  const customer = state.customers.find((entry) => entry.id === inspection.customerId);
  return [
    `Inspection: ${customer?.name || inspection.customerName || "Unknown Customer"}`,
    `Date: ${inspection.inspectionDate}`,
    `Draft Date: ${inspection.draftDate || "Not set"}`,
    `Zones: ${inspection.zoneCount || 0}`,
    `Issue Zones: ${inspection.issueZones || "None listed"}`,
    `Broken Heads: ${inspection.brokenHeads || 0}`,
    `Head Types: ${inspection.headTypes || "Not listed"}`,
    `Controller: ${inspection.controllerType || "Not listed"}`,
    `Controller Location: ${inspection.controllerLocation || "Not listed"}`,
    `Flags: ${formatInspectionFlags(inspection)}`,
    `Repairs Needed: ${inspection.repairsNeeded || "None listed"}`,
    `Materials Needed: ${inspection.materialsNeeded || "None listed"}`,
    `Notes: ${inspection.notes || "None listed"}`,
  ].join("\n");
}

function buildInspectionCustomerShareText(inspection, customer, linkedJob) {
  const customerName = customer?.name || inspection.customerName || "Customer";
  return [
    `Inspection Report for ${customerName}`,
    `Inspection Date: ${inspection.inspectionDate}`,
    `Inspection Type: ${linkedJob ? formatServiceLabel(linkedJob) : "Irrigation Inspection"}`,
    "",
    "Summary of findings:",
    `- Zones observed: ${inspection.zoneCount || 0}`,
    `- Zones with issues: ${inspection.issueZones || "None listed"}`,
    `- Broken heads observed: ${inspection.brokenHeads || 0}`,
    `- Controller: ${inspection.controllerType || "Not listed"}`,
    "",
    "Repairs that may be needed:",
    inspection.repairsNeeded || "None listed",
    "",
    "Additional notes:",
    inspection.notes || "None listed",
    "",
    "This inspection report is a summary of findings and is not a final quote.",
  ].join("\n");
}

function buildInspectionDraftNotes(inspection) {
  return [
    `Drafted from irrigation inspection on ${inspection.inspectionDate}.`,
    inspection.issueZones ? `Issue zones: ${inspection.issueZones}` : "",
    inspection.brokenHeads ? `Broken heads: ${inspection.brokenHeads}` : "",
    inspection.headTypes ? `Head types: ${inspection.headTypes}` : "",
    inspection.controllerType ? `Controller: ${inspection.controllerType}` : "",
    inspection.controllerLocation ? `Controller location: ${inspection.controllerLocation}` : "",
    inspection.repairsNeeded ? `Repairs needed: ${inspection.repairsNeeded}` : "",
    inspection.materialsNeeded ? `Materials needed: ${inspection.materialsNeeded}` : "",
    inspection.notes ? `Inspection notes: ${inspection.notes}` : "",
  ].filter(Boolean).join("\n");
}

function openInspectionReport(inspectionId) {
  const inspection = state.inspections.find((entry) => entry.id === inspectionId);
  if (!inspection) return;

  const customer = state.customers.find((entry) => entry.id === inspection.customerId);
  const linkedJob = inspection.jobId ? findJobById(inspection.jobId) : null;
  const customerName = customer?.name || inspection.customerName || "Customer";
  const fileName = `${slugify(customerName)}-inspection-report-${inspection.inspectionDate || formatDateKey(new Date())}.doc`;
  const reportHtml = buildInspectionReportDocument(inspection, customer, linkedJob);
  const viewerHtml = buildInspectionReportViewerDocument(inspection, customer, linkedJob, reportHtml, fileName);
  const blob = new Blob([viewerHtml], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  window.open(url, "_blank", "noopener,noreferrer");
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  showToast("Inspection report opened");
}

function buildInspectionReportDocument(inspection, customer, linkedJob) {
  const customerName = customer?.name || inspection.customerName || "Customer";
  const customerAddress = customer?.address || "";
  const customerPhone = customer?.phone || "";
  const findings = buildInspectionFindingsList(inspection);
  const recommendedRepairs = listFromText(inspection.repairsNeeded);
  const materialObservations = listFromText(inspection.materialsNeeded);
  const extraNotes = listFromText(inspection.notes);
  const serviceLabel = linkedJob ? formatServiceLabel(linkedJob) : "Irrigation Inspection";

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Inspection Report</title>
  <style>
    body { font-family: Arial, sans-serif; color: #1f2b1f; margin: 36px; line-height: 1.45; }
    h1, h2, h3, p { margin: 0; }
    .header { border-bottom: 2px solid #295b2d; padding-bottom: 12px; margin-bottom: 20px; }
    .brand { color: #295b2d; font-size: 24px; font-weight: 700; }
    .subhead { color: #5b675b; margin-top: 4px; }
    .meta { margin: 18px 0 20px; }
    .meta-row { margin: 4px 0; }
    .section { margin-top: 22px; }
    .section h2 { color: #295b2d; font-size: 18px; margin-bottom: 8px; }
    ul { margin: 8px 0 0 22px; }
    li { margin: 4px 0; }
    .note { margin-top: 22px; padding: 12px 14px; background: #f4efe3; border-left: 4px solid #d99c2b; }
  </style>
</head>
<body>
  <div class="header">
    <div class="brand">Weedless Lawn Care & Irrigation</div>
    <div class="subhead">Customer Irrigation Inspection Report</div>
  </div>

  <div class="meta">
    <p class="meta-row"><strong>Customer:</strong> ${escapeHtml(customerName)}</p>
    <p class="meta-row"><strong>Address:</strong> ${escapeHtml(customerAddress || "Not listed")}</p>
    <p class="meta-row"><strong>Phone:</strong> ${escapeHtml(customerPhone || "Not listed")}</p>
    <p class="meta-row"><strong>Inspection Date:</strong> ${escapeHtml(formatLongDate(inspection.inspectionDate || formatDateKey(new Date())))}</p>
    <p class="meta-row"><strong>Inspection Type:</strong> ${escapeHtml(serviceLabel)}</p>
  </div>

  <div class="section">
    <h2>Inspection Summary</h2>
    <p>This report summarizes what was observed during the irrigation inspection. It is intended to explain the current system condition and the repairs or improvements that may be needed. A separate quote can be prepared from these findings if requested.</p>
  </div>

  <div class="section">
    <h2>Findings</h2>
    <ul>${findings}</ul>
  </div>

  <div class="section">
    <h2>Repairs That May Be Needed</h2>
    <ul>${recommendedRepairs}</ul>
  </div>

  <div class="section">
    <h2>Material / Equipment Observations</h2>
    <ul>${materialObservations}</ul>
  </div>

  <div class="section">
    <h2>Additional Notes</h2>
    <ul>${extraNotes}</ul>
  </div>

  <div class="note">
    This inspection report is not a final quote. It is a customer-friendly summary of the observed system condition and likely repair needs.
  </div>
</body>
</html>`;
}

function buildInspectionReportViewerDocument(inspection, customer, linkedJob, reportHtml, fileName) {
  const customerName = customer?.name || inspection.customerName || "Customer";
  const shareText = buildInspectionCustomerShareText(inspection, customer, linkedJob);
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Inspection Report</title>
  <style>
    body { margin: 0; font-family: Arial, sans-serif; background: #f4efe3; color: #1f2b1f; }
    .toolbar { position: sticky; top: 0; z-index: 10; display: flex; flex-wrap: wrap; gap: 10px; padding: 14px 16px; background: #295b2d; }
    .toolbar button { border: 0; border-radius: 999px; padding: 10px 14px; font-weight: 700; cursor: pointer; }
    .toolbar .primary { background: #fff; color: #295b2d; }
    .toolbar .secondary { background: #dceacc; color: #183c1b; }
    .toolbar .ghost { background: #ece7d7; color: #183c1b; }
    .toolbar .label { color: #fff; font-weight: 700; align-self: center; margin-right: auto; }
    .page { max-width: 920px; margin: 0 auto; padding: 18px; }
    .frame { background: #fffaf0; border-radius: 18px; box-shadow: 0 12px 28px rgba(34, 50, 36, 0.12); overflow: hidden; }
    iframe { width: 100%; min-height: calc(100vh - 120px); border: 0; background: #fff; }
    @media print {
      .toolbar { display: none; }
      .page { padding: 0; max-width: none; }
      .frame { box-shadow: none; border-radius: 0; }
      iframe { min-height: auto; }
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <div class="label">Inspection Report: ${escapeHtml(customerName)}</div>
    <button class="primary" onclick="printReport()">Print</button>
    <button class="secondary" onclick="downloadWord()">Download Word</button>
    <button class="ghost" onclick="shareReport()">Share / Send</button>
  </div>
  <div class="page">
    <div class="frame">
      <iframe id="reportFrame"></iframe>
    </div>
  </div>
  <script>
    const reportHtml = ${JSON.stringify(reportHtml)};
    const fileName = ${JSON.stringify(fileName)};
    const shareText = ${JSON.stringify(shareText)};
    const shareTitle = ${JSON.stringify(`Inspection Report - ${customerName}`)};
    const frame = document.getElementById("reportFrame");
    frame.srcdoc = reportHtml;

    function printReport() {
      frame.contentWindow.focus();
      frame.contentWindow.print();
    }

    function downloadWord() {
      const blob = new Blob([reportHtml], { type: "application/msword;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = fileName;
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    }

    async function shareReport() {
      try {
        if (navigator.share) {
          await navigator.share({ title: shareTitle, text: shareText });
          return;
        }
      } catch {}

      try {
        await navigator.clipboard.writeText(shareText);
        alert("Inspection report summary copied. You can paste it into a text or email.");
      } catch {
        alert("Sharing is not available on this device.");
      }
    }
  </script>
</body>
</html>`;
}

function buildInspectionFindingsList(inspection) {
  const findings = [
    `Zone count observed: ${inspection.zoneCount || 0}`,
    `Zones with issues: ${inspection.issueZones || "None listed"}`,
    `Broken or damaged heads observed: ${inspection.brokenHeads || 0}`,
    `Head types observed: ${inspection.headTypes || "Not listed"}`,
    `Controller type: ${inspection.controllerType || "Not listed"}`,
    `Controller location: ${inspection.controllerLocation || "Not listed"}`,
  ];

  if (inspection.leakDetected) findings.push("Leak symptoms were observed during the inspection.");
  if (inspection.valveIssue) findings.push("A valve-related issue was identified during the inspection.");
  if (inspection.wiringIssue) findings.push("A wiring-related issue was identified during the inspection.");
  if (inspection.controllerIssue) findings.push("A controller-related issue was identified during the inspection.");

  return findings.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
}

function listFromText(text) {
  const items = String(text || "")
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);

  if (!items.length) {
    return "<li>None listed.</li>";
  }

  return items.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
}

function slugify(value) {
  return String(value || "inspection")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "inspection";
}

function syncCustomerReferences(customer) {
  Object.values(state.schedules).forEach((jobs) => {
    jobs.forEach((job) => {
      if (job.customerId === customer.id) {
        job.customerName = customer.name;
        job.phone = customer.phone;
        job.address = customer.address;
      }
    });
  });
  state.inspections.forEach((inspection) => {
    if (inspection.customerId === customer.id) {
      inspection.customerName = customer.name;
    }
  });
}

function suggestNextWindow(job, jobs) {
  const activeJobs = jobs.filter((entry) => entry.status !== "Completed");
  const position = activeJobs.findIndex((entry) => entry.id === job.id);
  const previous = activeJobs[position - 1];
  const start = previous?.timeWindowEnd || addMinutes(job.timeWindowStart, 30);
  const end = addMinutes(start, job.estimatedDuration);
  return { start, end };
}

function timestampSummary(job) {
  if (job.completedTime) return `Done ${formatClock(job.completedTime)}`;
  if (job.startTime) return `Started ${formatClock(job.startTime)}`;
  if (job.onMyWayTime) return `OMW ${formatClock(job.onMyWayTime)}`;
  return "";
}

function saveState() {
  persistLocalState(state);
  queueRemoteSave();
}

function persistLocalState(nextState) {
  localStorage.setItem(STORAGE_KEY, serializeState(nextState));
}

function queueRemoteSave() {
  if (!syncState.provider || syncState.applyingRemote) return;
  clearTimeout(syncState.saveTimer);
  syncState.saveTimer = setTimeout(() => {
    void pushRemoteState();
  }, 250);
}

async function pushRemoteState() {
  if (!syncState.provider) return;

  try {
    const { error } = await syncState.provider.client
      .from("app_state")
      .upsert(
        {
          id: syncState.rowId,
          payload: sanitizeStateForSave(state),
        },
        { onConflict: "id" },
      );

    if (error) throw error;
    syncState.mode = "supabase";
    syncState.error = "";
  } catch (error) {
    console.error("Cloud save failed:", error);
    syncState.error = "save failed";
  }

  renderSyncStatus();
}

async function copyText(text, successMessage) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const fallback = document.createElement("textarea");
    fallback.value = text;
    fallback.setAttribute("readonly", "");
    fallback.style.position = "absolute";
    fallback.style.left = "-9999px";
    document.body.append(fallback);
    fallback.select();
    document.execCommand("copy");
    fallback.remove();
  }
  showToast(successMessage);
  saveState();
  renderTodayJobs();
}

async function refreshSmsStatus() {
  const functionUrl = WEEDLESS_CONFIG.twilio?.functionUrl;

  if (functionUrl) {
    try {
      const response = await fetch(functionUrl, {
        method: "GET",
      });
      if (!response.ok) throw new Error("twilio function unavailable");
      const data = await response.json();
      smsState.enabled = Boolean(data.smsEnabled);
      renderSmsStatus();
      return;
    } catch {
      smsState.enabled = false;
    }
  }

  try {
    const response = await fetch("/api/status", { cache: "no-store" });
    if (!response.ok) throw new Error("status unavailable");
    const data = await response.json();
    smsState.enabled = Boolean(data.smsEnabled);
  } catch {
    smsState.enabled = false;
  }
  renderSmsStatus();
}

async function sendCustomerMessage(job, message, sentMessage, copiedMessage) {
  const smsEndpoint = getSmsEndpoint();
  if (!smsState.enabled) {
    await copyText(message, copiedMessage);
    return false;
  }

  try {
    const response = await fetch(smsEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        to: job.phone,
        body: message,
      }),
    });

    if (!response.ok) {
      const errorPayload = await response.json().catch(() => ({}));
      throw new Error(errorPayload.error || "SMS send failed");
    }

    showToast(sentMessage);
    return true;
  } catch (error) {
    console.error(error);
    smsState.enabled = false;
    renderSmsStatus();
    await copyText(message, `${copiedMessage} (Twilio unavailable)`);
    return false;
  }
}

function getSmsEndpoint() {
  return WEEDLESS_CONFIG.twilio?.functionUrl || "/api/send-sms";
}

function showToast(message) {
  const existing = document.querySelector(".toast");
  if (existing) existing.remove();
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = message;
  document.body.append(toast);
  setTimeout(() => toast.remove(), 2400);
}

function formatDateKey(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function getTodayKey() {
  return formatDateKey(new Date());
}

function getTomorrowKey() {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  return formatDateKey(tomorrow);
}

function getPlanningDateKey() {
  return state.ui.scheduleDate || getTomorrowKey();
}

function getNextDateKey(dateKey) {
  const nextDate = new Date(`${dateKey}T00:00:00`);
  nextDate.setDate(nextDate.getDate() + 1);
  return formatDateKey(nextDate);
}

function formatLongDate(dateKey) {
  const date = new Date(`${dateKey}T00:00:00`);
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function formatTime(value) {
  const [hourText, minute] = value.split(":");
  const hour = Number(hourText);
  const suffix = hour >= 12 ? "PM" : "AM";
  const displayHour = hour % 12 || 12;
  return `${displayHour}:${minute} ${suffix}`;
}

function addMinutes(timeValue, minutesToAdd) {
  const [hourText, minuteText] = timeValue.split(":");
  const totalMinutes = Number(hourText) * 60 + Number(minuteText) + minutesToAdd;
  const nextHour = Math.floor(totalMinutes / 60);
  const nextMinute = totalMinutes % 60;
  return `${String(nextHour).padStart(2, "0")}:${String(nextMinute).padStart(2, "0")}`;
}

function formatClock(isoText) {
  return new Date(isoText).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

function escapeHtml(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js").catch(() => {});
    });
  }
}

function migrateState(savedState) {
  const customers = Array.isArray(savedState?.customers) ? savedState.customers : sampleCustomers;
  const schedules = savedState?.schedules && typeof savedState.schedules === "object" ? savedState.schedules : {};
  const inspections = Array.isArray(savedState?.inspections) ? savedState.inspections : [];

  Object.values(schedules).forEach((jobs) => {
    if (!Array.isArray(jobs)) return;
    jobs.forEach((job) => {
      if (job.serviceType === "Weed Spray") {
        job.serviceType = LAWN_TREATMENT_SERVICE;
      }
      job.serviceRound = normalizeServiceRound(job.serviceType, job.serviceRound);
      job.projectId = job.projectId || crypto.randomUUID();
      job.projectName = job.projectName || "";
      job.assignedTo = job.assignedTo || "";
      job.notes = job.notes || "";
    });
  });

  inspections.forEach((inspection) => {
    inspection.customerName = inspection.customerName || "";
    inspection.jobId = inspection.jobId || "";
    inspection.jobDate = inspection.jobDate || "";
    inspection.inspectionDate = inspection.inspectionDate || formatDateKey(new Date());
    inspection.draftDate = inspection.draftDate || getTomorrowKey();
    inspection.zoneCount = Number(inspection.zoneCount || 0);
    inspection.issueZones = inspection.issueZones || "";
    inspection.brokenHeads = Number(inspection.brokenHeads || 0);
    inspection.headTypes = inspection.headTypes || "";
    inspection.controllerType = inspection.controllerType || "";
    inspection.controllerLocation = inspection.controllerLocation || "";
    inspection.leakDetected = Boolean(inspection.leakDetected);
    inspection.valveIssue = Boolean(inspection.valveIssue);
    inspection.wiringIssue = Boolean(inspection.wiringIssue);
    inspection.controllerIssue = Boolean(inspection.controllerIssue);
    inspection.repairsNeeded = inspection.repairsNeeded || "";
    inspection.materialsNeeded = inspection.materialsNeeded || "";
    inspection.notes = inspection.notes || "";
    inspection.createdAt = inspection.createdAt || new Date().toISOString();
    inspection.updatedAt = inspection.updatedAt || inspection.createdAt;
  });

  return {
    customers,
    schedules,
    inspections,
    ui: {
      activeView: savedState?.ui?.activeView || "dashboard",
      scheduleDate: savedState?.ui?.scheduleDate || getTomorrowKey(),
      editingCustomerId: null,
    },
  };
}

function isIrrigationService(serviceType) {
  return serviceType === "Irrigation Repair" || serviceType === "Irrigation Install";
}

function normalizeServiceRound(serviceType, serviceRound) {
  if (serviceType !== LAWN_TREATMENT_SERVICE) return null;
  const round = Number(serviceRound);
  return LAWN_TREATMENT_ROUNDS.includes(round) ? round : 1;
}

function formatServiceLabel(job) {
  if (job.serviceType !== LAWN_TREATMENT_SERVICE) return job.serviceType;
  return `${job.serviceType}: Round ${normalizeServiceRound(job.serviceType, job.serviceRound)}`;
}

function getFirstName(fullName) {
  return String(fullName || "").trim().split(/\s+/)[0] || "";
}

function sanitizeStateForSave(sourceState) {
  return migrateState(deepClone(sourceState));
}

function exportCompletedJobs() {
  const completedJobs = Object.values(state.schedules)
    .flat()
    .filter((job) => job.status === "Completed");

  if (!completedJobs.length) {
    showToast("No completed jobs to export");
    return;
  }

  const rows = [
    [
      "Date",
      "Customer",
      "Service",
      "Project Name",
      "Assigned Crew",
      "Status",
      "Start Time",
      "Completed Time",
      "Minutes Spent",
      "Hours Spent",
      "Address",
      "Notes",
    ],
    ...completedJobs.map((job) => {
      const minutesSpent = calculateTimeSpentMinutes(job);
      return [
        job.date,
        job.customerName,
        formatServiceLabel(job),
        job.projectName || "",
        job.assignedTo || "",
        job.status,
        formatTimestamp(job.startTime),
        formatTimestamp(job.completedTime),
        minutesSpent === "" ? "" : String(minutesSpent),
        minutesSpent === "" ? "" : (minutesSpent / 60).toFixed(2),
        job.address,
        job.notes || "",
      ];
    }),
  ];

  const csv = rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `weedless-completed-jobs-${getTodayKey()}.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  showToast("Completed jobs exported");
}

function calculateTimeSpentMinutes(job) {
  if (!job.startTime || !job.completedTime) return "";
  const start = new Date(job.startTime);
  const end = new Date(job.completedTime);
  const diffMs = end - start;
  if (!Number.isFinite(diffMs) || diffMs <= 0) return "";
  return Math.round(diffMs / 60000);
}

function formatTimestamp(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString([], {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
  });
}

function csvCell(value) {
  const text = String(value ?? "");
  return `"${text.replaceAll("\"", "\"\"")}"`;
}

function serializeState(value) {
  return JSON.stringify(value);
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}
