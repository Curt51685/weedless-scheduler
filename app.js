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
  todayJobId: document.getElementById("todayJobId"),
  todayJobCustomer: document.getElementById("todayJobCustomer"),
  todayJobServiceType: document.getElementById("todayJobServiceType"),
  todayJobRoundField: document.getElementById("todayJobRoundField"),
  todayJobServiceRound: document.getElementById("todayJobServiceRound"),
  tomorrowJobs: document.getElementById("tomorrowJobs"),
  messageList: document.getElementById("messageList"),
  customerList: document.getElementById("customerList"),
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
    ui: {
      activeView: "dashboard",
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

function buildJob(customer, serviceType, estimatedDuration, order, windowStart, windowEnd, dateKey, serviceRound = null) {
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
  };
}

function wireEvents() {
  refs.tabButtons.forEach((button) => {
    button.addEventListener("click", () => setActiveView(button.dataset.view));
  });

  refs.jobForm.addEventListener("submit", handleAddJob);
  refs.todayJobForm.addEventListener("submit", handleSaveTodayJob);
  refs.customerForm.addEventListener("submit", handleSaveCustomer);
  refs.cancelCustomerEditBtn.addEventListener("click", resetCustomerForm);
  refs.cancelTodayJobEditBtn.addEventListener("click", closeTodayJobForm);
  refs.openTodayJobFormBtn.addEventListener("click", openTodayJobFormForCreate);
  refs.jobServiceType.addEventListener("change", syncRoundFieldVisibility);
  refs.todayJobServiceType.addEventListener("change", syncTodayRoundFieldVisibility);
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
  renderCustomerOptions();
  syncRoundFieldVisibility();
  syncTodayRoundFieldVisibility();
  syncTomorrowEndTime();
  syncTodayEndTime();
  renderSmsStatus();
  renderSyncStatus();
  renderTodayJobs();
  renderTomorrowJobs();
  renderCustomers();
  renderMessages();
  if (!refs.todayJobId.value) {
    resetTodayJobForm();
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
  const options = customers
    .map((customer) => `<option value="${customer.id}">${customer.name} - ${customer.address}</option>`)
    .join("");
  refs.jobCustomer.innerHTML = options;
  refs.todayJobCustomer.innerHTML = options;
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
  const duration = Number(document.getElementById("jobDuration").value || 60);
  document.getElementById("jobTimeEnd").value = addMinutes(start, duration);
}

function syncTodayEndTime() {
  const start = document.getElementById("todayJobTimeStart").value || "08:00";
  const duration = Number(document.getElementById("todayJobDuration").value || 60);
  document.getElementById("todayJobTimeEnd").value = addMinutes(start, duration);
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
      <button class="warn" data-action="delete-today">Delete</button>
    `;
    editGroup.addEventListener("click", (event) => handleTodayAdjustAction(event, job.id));
    card.append(editGroup);
    refs.todayJobs.append(card);
  });
}

function renderTomorrowJobs() {
  const tomorrowJobs = getJobsForDate(getTomorrowKey());
  refs.tomorrowJobs.innerHTML = "";

  if (!tomorrowJobs.length) {
    refs.tomorrowJobs.innerHTML = '<div class="empty-state">Add tomorrow\'s jobs here.</div>';
    return;
  }

  tomorrowJobs.forEach((job) => {
    const card = createJobCard(job, false, false);
    const editGroup = document.createElement("div");
    editGroup.className = "job-actions";
    editGroup.innerHTML = `
      <button class="secondary" data-action="move-up">Move Up</button>
      <button class="secondary" data-action="move-down">Move Down</button>
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

function renderMessages() {
  const tomorrowJobs = getJobsForDate(getTomorrowKey());
  if (!tomorrowJobs.length) {
    refs.messageList.className = "message-list empty-state";
    refs.messageList.textContent = "Generate messages after adding tomorrow's jobs.";
    return;
  }

  refs.messageList.className = "message-list";
  refs.messageList.innerHTML = "";
  tomorrowJobs.forEach((job) => {
    const message = buildNightBeforeMessage(job);
    const card = document.createElement("article");
    card.className = "message-card";
    card.innerHTML = `
      <h4>${escapeHtml(job.customerName)}</h4>
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

  sortJobs(todayKey);
  saveState();
  renderTodayJobs();
}

function handleTomorrowJobAction(event, jobId) {
  const action = event.target.dataset.action;
  if (!action) return;
  const tomorrowKey = getTomorrowKey();
  const jobs = getJobsForDate(tomorrowKey);
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
  const end = document.getElementById("jobTimeEnd").value || addMinutes(start, duration);
  const tomorrowKey = getTomorrowKey();
  const jobs = getJobsForDate(tomorrowKey);

  const job = buildJob(customer, serviceType, duration, order, start, end, tomorrowKey, serviceRound);
  jobs.push(job);
  sortJobs(tomorrowKey);
  reindexJobs(tomorrowKey);
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
  showToast("Job added to tomorrow");
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
  const end = document.getElementById("todayJobTimeEnd").value || addMinutes(start, duration);

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
    });
    showToast("Today's job updated");
  } else {
    jobs.push(buildJob(customer, serviceType, duration, order, start, end, todayKey, serviceRound));
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
  document.getElementById("todayJobDuration").value = job.estimatedDuration;
  document.getElementById("todayJobOrder").value = job.order;
  document.getElementById("todayJobTimeStart").value = job.timeWindowStart;
  document.getElementById("todayJobTimeEnd").value = job.timeWindowEnd;
  syncTodayRoundFieldVisibility();
  syncTodayEndTime();
  refs.todayJobForm.scrollIntoView({ behavior: "smooth", block: "start" });
}

function resetCustomerForm() {
  refs.customerForm.reset();
  refs.customerId.value = "";
  refs.customerFormTitle.textContent = "Add Customer";
}

function resetTodayJobForm() {
  refs.todayJobForm.reset();
  refs.todayJobId.value = "";
  refs.todayJobFormTitle.textContent = "Add Job Today";
  document.getElementById("todayJobDuration").value = 60;
  document.getElementById("todayJobOrder").value = getJobsForDate(getTodayKey()).length + 1;
  document.getElementById("todayJobTimeStart").value = "08:00";
  document.getElementById("todayJobTimeEnd").value = "09:00";
  refs.todayJobServiceRound.value = "1";
  syncTodayRoundFieldVisibility();
  syncTodayEndTime();
}

function openTodayJobForm() {
  refs.todayJobForm.hidden = false;
  refs.todayJobForm.removeAttribute("hidden");
  refs.todayJobForm.style.display = "";
}

function closeTodayJobForm() {
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

function deleteCustomer(customerId) {
  state.customers = state.customers.filter((entry) => entry.id !== customerId);
  Object.keys(state.schedules).forEach((dateKey) => {
    state.schedules[dateKey] = state.schedules[dateKey].filter((job) => job.customerId !== customerId);
  });
  saveState();
  renderCustomerOptions();
  renderCustomers();
  renderTodayJobs();
  renderTomorrowJobs();
  renderMessages();
  showToast("Customer deleted");
}

function autoAssignTomorrowWindows() {
  const tomorrowKey = getTomorrowKey();
  const jobs = getJobsForDate(tomorrowKey);
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
  showToast("Tomorrow windows assigned");
}

function clearTomorrow() {
  state.schedules[getTomorrowKey()] = [];
  saveState();
  renderTomorrowJobs();
  renderMessages();
  showToast("Tomorrow cleared");
}

function syncDashboardFromToday() {
  const todayJobs = getJobsForDate(getTodayKey());
  if (!todayJobs.length) {
    state.schedules[getTodayKey()] = [];
  }
  saveState();
}

function getJobsForDate(dateKey) {
  if (!state.schedules[dateKey]) state.schedules[dateKey] = [];
  return state.schedules[dateKey];
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
  return getJobsForDate(getTomorrowKey()).map(buildNightBeforeMessage).join("\n\n");
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
  return `Hey ${getFirstName(job.customerName)}, this is Weedless Lawn Care & Irrigation. I've got you scheduled for tomorrow with an arrival window of ${job.timeWindow} for ${formatServiceLabel(job)}. Let me know if that works. Thanks!`;
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
  if (!smsState.enabled) {
    await copyText(message, copiedMessage);
    return false;
  }

  try {
    const response = await fetch("/api/send-sms", {
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

  Object.values(schedules).forEach((jobs) => {
    if (!Array.isArray(jobs)) return;
    jobs.forEach((job) => {
      if (job.serviceType === "Weed Spray") {
        job.serviceType = LAWN_TREATMENT_SERVICE;
      }
      job.serviceRound = normalizeServiceRound(job.serviceType, job.serviceRound);
    });
  });

  return {
    customers,
    schedules,
    ui: {
      activeView: savedState?.ui?.activeView || "dashboard",
      editingCustomerId: null,
    },
  };
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

function serializeState(value) {
  return JSON.stringify(value);
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}
