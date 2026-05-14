const corsHeaders = {
  "Access-Control-Allow-Origin": process.env.ALLOWED_ORIGIN || "*",
  "Access-Control-Allow-Headers": "content-type,authorization",
  "Access-Control-Allow-Methods": "OPTIONS,POST"
};

const defaultStandards = [
  "ISO/SAE 21434",
  "UNECE R155 / R156",
  "ISO 26262",
  "IEC 61508",
  "IEC 61511",
  "ISO 13849",
  "ATEX Directive 2014/34/EU",
  "ATEX Workplace Directive 1999/92/EC",
  "IEC 62443",
  "ISO 27001 / 27002",
  "NIST SP 800-115",
  "TISAX",
  "EU Cyber Resilience Act",
  "NIS2",
  "UL 2900",
  "UKCA / CE Market Access"
];

export async function handler(event) {
  if (event.requestContext?.http?.method === "OPTIONS" || event.httpMethod === "OPTIONS") {
    return response(204, {});
  }

  try {
    const body = parseRequestBody(event);
    if (body.task === "health-check") {
      const result = await healthCheck();
      return response(200, result);
    }

    if (body.task === "state-load") {
      const result = await loadAppState();
      return response(200, result);
    }

    if (body.task === "state-save") {
      const result = await saveAppState(body.state || {});
      return response(200, result);
    }

    if (body.task === "standards-update") {
      const result = await enrichStandardsUpdate(body);
      return response(200, result);
    }

    if (body.task === "scheduled-standards-watch") {
      const result = await runScheduledStandardsWatch(body);
      return response(200, result);
    }

    if (body.task === "send-notification") {
      const result = await sendNotificationTask(body);
      return response(200, result);
    }

    if (!body.name || !String(body.name).trim()) {
      return response(400, { error: "Customer name is required." });
    }

    let result;
    try {
      result = process.env.ANTHROPIC_API_KEY
        ? await enrichWithClaude(body)
        : process.env.OPENAI_API_KEY
          ? await enrichWithAi(body)
          : deterministicEnrichment(body);
    } catch (aiError) {
      result = deterministicEnrichment(body);
      result.status = "ai_error_fallback";
      result.notice = `AI enrichment failed: ${aiError.message}`;
      result.customer.evidence_notes = [
        ...(result.customer.evidence_notes || []),
        `AI enrichment failed: ${aiError.message}`
      ];
    }

    await saveCustomerProfile(result.customer, result.status);

    return response(200, result);
  } catch (error) {
    return response(error.statusCode || 500, {
      error: "Customer enrichment failed.",
      detail: error.message
    });
  }
}

function parseRequestBody(event) {
  if (!event?.body) return {};
  if (typeof event.body === "object") return event.body;
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;
  return JSON.parse(rawBody || "{}");
}

async function healthCheck() {
  const checks = {
    lambda: "ok",
    aiProvider: process.env.ANTHROPIC_API_KEY
      ? `anthropic:${process.env.ANTHROPIC_MODEL || "default"}`
      : process.env.OPENAI_API_KEY
        ? `openai:${process.env.OPENAI_MODEL || "default"}`
        : "rule-based fallback",
    sharedStorage: process.env.APP_STATE_TABLE ? "configured" : "not configured",
    customerAuditTable: process.env.CUSTOMER_TABLE ? "configured" : "not configured",
    standardsAuditTable: process.env.STANDARDS_TABLE ? "configured" : "not configured",
    teamsNotifications: process.env.TEAMS_WEBHOOK_URL ? "configured" : "not configured",
    emailNotifications: process.env.NOTIFICATION_FROM_EMAIL ? "configured" : "not configured"
  };

  let updatedAt = "";
  if (process.env.APP_STATE_TABLE) {
    try {
      const state = await loadAppState();
      checks.sharedStorage = "connected";
      updatedAt = state.updatedAt || "";
    } catch (error) {
      checks.sharedStorage = "error";
      checks.sharedStorageDetail = error.message;
    }
  }

  return {
    status: checks.sharedStorage === "error" ? "degraded" : "ok",
    checks,
    updatedAt,
    timestamp: new Date().toISOString()
  };
}

function appStateTableName() {
  if (!process.env.APP_STATE_TABLE) {
    const error = new Error("Shared app-state storage is not configured. Create a DynamoDB table and set APP_STATE_TABLE on the Lambda.");
    error.statusCode = 501;
    throw error;
  }
  return process.env.APP_STATE_TABLE;
}

async function dynamoDocumentClient() {
  const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
  const { DynamoDBDocumentClient } = await import("@aws-sdk/lib-dynamodb");
  return DynamoDBDocumentClient.from(new DynamoDBClient({}));
}

function emptyAppState() {
  return {
    standards: [],
    customers: [],
    users: [],
    adminRequests: [],
    impactReviews: [],
    watchSchedule: {},
    auditEvents: []
  };
}

function sanitizeAppState(state = {}) {
  return {
    standards: Array.isArray(state.standards) ? state.standards : [],
    customers: Array.isArray(state.customers) ? state.customers : [],
    users: Array.isArray(state.users) ? state.users : [],
    adminRequests: Array.isArray(state.adminRequests) ? state.adminRequests : [],
    impactReviews: Array.isArray(state.impactReviews) ? state.impactReviews : [],
    watchSchedule: state.watchSchedule && typeof state.watchSchedule === "object" ? state.watchSchedule : {},
    auditEvents: Array.isArray(state.auditEvents) ? state.auditEvents.slice(0, 250) : []
  };
}

async function loadAppState() {
  const tableName = appStateTableName();
  const dynamo = await dynamoDocumentClient();
  const { GetCommand } = await import("@aws-sdk/lib-dynamodb");
  const result = await dynamo.send(new GetCommand({
    TableName: tableName,
    Key: {
      pk: "APP#assurance-intelligence-hub",
      sk: "STATE#current"
    }
  }));

  return {
    status: "loaded",
    storage: "dynamodb",
    state: result.Item?.state || emptyAppState(),
    updatedAt: result.Item?.updated_at || ""
  };
}

async function saveAppState(state) {
  const tableName = appStateTableName();
  const dynamo = await dynamoDocumentClient();
  const { PutCommand } = await import("@aws-sdk/lib-dynamodb");
  const updatedAt = new Date().toISOString();
  const cleanState = sanitizeAppState(state);

  await dynamo.send(new PutCommand({
    TableName: tableName,
    Item: {
      pk: "APP#assurance-intelligence-hub",
      sk: "STATE#current",
      state: cleanState,
      updated_at: updatedAt
    }
  }));

  return {
    status: "saved",
    storage: "dynamodb",
    updatedAt
  };
}

function actorFrom(body = {}) {
  const actor = body.actor || {};
  return {
    name: String(actor.name || body.actorName || "System").trim() || "System",
    role: String(actor.role || body.actorRole || (body.source === "github-actions" ? "Automation" : "System")).trim() || "System",
    email: String(actor.email || body.actorEmail || "").trim()
  };
}

function auditEvent(action, target, detail = "", actor = { name: "System", role: "System" }, extra = {}) {
  return {
    id: `audit-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    at: new Date().toISOString(),
    actor: actor.name || "System",
    role: actor.role || "System",
    action,
    targetType: target?.type || "workspace",
    targetName: target?.name || "TRNA CCB",
    detail,
    ...extra
  };
}

function withAudit(state, event) {
  return {
    ...state,
    auditEvents: [event, ...sanitizeAppState(state).auditEvents].slice(0, 250)
  };
}

async function saveCustomerProfile(customer, status) {
  if (!process.env.CUSTOMER_TABLE) return;

  const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
  const { DynamoDBDocumentClient, PutCommand } = await import("@aws-sdk/lib-dynamodb");
  const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const createdAt = new Date().toISOString();

  await dynamo.send(new PutCommand({
    TableName: process.env.CUSTOMER_TABLE,
    Item: {
      pk: `CUSTOMER#${slug(customer.name)}`,
      sk: `PROFILE#${createdAt}`,
      ...customer,
      enrichment_status: status,
      created_at: createdAt
    }
  }));
}

async function enrichWithAi(body) {
  const standards = Array.isArray(body.standards) && body.standards.length
    ? body.standards.map((standard) => ({
      name: standard.name,
      domain: standard.domain,
      sector: standard.sector,
      markets: standard.markets,
      topics: standard.topics,
      description: standard.description
    }))
    : defaultStandards;

  const prompt = buildEnrichmentPrompt(body, standards);

  const aiResponse = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
      input: prompt,
      text: { format: { type: "json_object" } }
    })
  });

  if (!aiResponse.ok) {
    const text = await aiResponse.text();
    throw new Error(`AI provider returned ${aiResponse.status}: ${text}`);
  }

  const payload = await aiResponse.json();
  const text = payload.output_text || payload.output?.flatMap((item) => item.content || []).map((part) => part.text || "").join("");
  if (!text) throw new Error("AI provider returned no JSON text.");
  return parseJsonObject(text);
}

async function enrichWithClaude(body) {
  const standards = Array.isArray(body.standards) && body.standards.length
    ? body.standards.map((standard) => ({
      name: standard.name,
      domain: standard.domain,
      sector: standard.sector,
      markets: standard.markets,
      topics: standard.topics,
      description: standard.description
    }))
    : defaultStandards;

  const prompt = buildEnrichmentPrompt(body, standards);
  const aiResponse = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || "claude-3-5-haiku-20241022",
      max_tokens: 2200,
      system: "You enrich customer profiles for assurance, cybersecurity, functional safety, and market-access teams. Return only a valid JSON object. Do not include markdown, comments, prose, or trailing commas.",
      messages: [
        {
          role: "user",
          content: prompt
        }
      ]
    })
  });

  if (!aiResponse.ok) {
    const text = await aiResponse.text();
    throw new Error(`Anthropic returned ${aiResponse.status}: ${text}`);
  }

  const payload = await aiResponse.json();
  const text = (payload.content || [])
    .map((part) => part.type === "text" ? part.text : "")
    .join("")
    .trim();
  if (!text) throw new Error("Anthropic returned no JSON text.");
  return parseJsonObject(text);
}

function parseJsonObject(text) {
  const trimmed = String(text || "").trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) return JSON.parse(fenced[1].trim());
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error("AI provider returned text that was not valid JSON.");
  }
}

async function enrichStandardsUpdate(body) {
  const checkedAt = new Date().toISOString();
  const batchSize = Math.max(1, Math.min(Number(process.env.STANDARDS_BATCH_SIZE || 6), 12));
  const inputStandards = Array.isArray(body.standards) ? body.standards : [];
  const standards = inputStandards
    .filter((standard) => standard?.name)
    .slice(0, batchSize)
    .map(sanitizeStandardInput);

  if (!standards.length) {
    return {
      status: "no_standards",
      checkedAt,
      standards: []
    };
  }

  const sourceSnapshots = await Promise.all(standards.map((standard) => fetchStandardSource(standard, checkedAt)));

  let result;
  try {
    result = process.env.ANTHROPIC_API_KEY
      ? await enrichStandardsWithClaude(sourceSnapshots, checkedAt)
      : process.env.OPENAI_API_KEY
        ? await enrichStandardsWithOpenAi(sourceSnapshots, checkedAt)
        : deterministicStandardsUpdate(sourceSnapshots, checkedAt);
  } catch (aiError) {
    result = deterministicStandardsUpdate(sourceSnapshots, checkedAt);
    result.status = "ai_error_source_review";
    result.notice = `AI standards enrichment failed: ${aiError.message}`;
  }

  await saveStandards(result.standards || [], checkedAt, result.status);
  return result;
}

function sanitizeStandardInput(standard) {
  return {
    name: String(standard.name || "").trim(),
    domain: String(standard.domain || "Cybersecurity").trim(),
    sector: String(standard.sector || "General").trim(),
    markets: normalizeList(standard.markets),
    topics: normalizeList(standard.topics),
    description: String(standard.description || "").trim(),
    status: String(standard.status || "Watch").trim(),
    sourceUrl: String(standard.sourceUrl || "").trim(),
    internalNotes: String(standard.internalNotes || "").trim(),
    changes: Array.isArray(standard.changes) ? standard.changes.slice(0, 5) : []
  };
}

async function fetchStandardSource(standard, checkedAt) {
  const snapshot = {
    ...standard,
    sourceCheckedAt: checkedAt,
    sourceStatus: standard.sourceUrl ? "pending" : "missing_source_url",
    sourceHttpStatus: "",
    sourceTitle: "",
    sourceExtract: ""
  };
  if (!standard.sourceUrl) return snapshot;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Number(process.env.SOURCE_FETCH_TIMEOUT_MS || 9000));
    const sourceResponse = await fetch(standard.sourceUrl, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "Accept": "text/html,application/xhtml+xml,application/xml,text/plain;q=0.9,*/*;q=0.8",
        "User-Agent": "AssuranceIntelligenceHub/1.0 standards-source-review"
      }
    });
    clearTimeout(timeout);

    const raw = await sourceResponse.text();
    const title = extractTitle(raw);
    snapshot.sourceHttpStatus = sourceResponse.status;
    snapshot.sourceTitle = title;
    snapshot.sourceStatus = sourceResponse.ok ? "source_fetched" : `source_http_${sourceResponse.status}`;
    snapshot.sourceExtract = htmlToText(raw).slice(0, Number(process.env.SOURCE_EXTRACT_CHARS || 5000));
  } catch (error) {
    snapshot.sourceStatus = `source_fetch_failed: ${error.name === "AbortError" ? "timeout" : error.message}`;
  }
  return snapshot;
}

function extractTitle(html) {
  const title = String(html || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
    || String(html || "").match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1]
    || "";
  return decodeEntities(stripTags(title)).trim().slice(0, 180);
}

function htmlToText(html) {
  return decodeEntities(
    stripTags(
      String(html || "")
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
        .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    )
  ).replace(/\s+/g, " ").trim();
}

function stripTags(value) {
  return String(value || "").replace(/<[^>]+>/g, " ");
}

function decodeEntities(value) {
  return String(value || "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

async function enrichStandardsWithClaude(sourceSnapshots, checkedAt) {
  const prompt = buildStandardsPrompt(sourceSnapshots, checkedAt);
  const aiResponse = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || "claude-3-5-haiku-20241022",
      max_tokens: 3500,
      system: "You enrich a standards and regulations library for assurance, cybersecurity, functional safety, and market-access teams. Use only the provided source extracts and prior user-provided record data. Return only valid JSON.",
      messages: [
        {
          role: "user",
          content: prompt
        }
      ]
    })
  });

  if (!aiResponse.ok) {
    const text = await aiResponse.text();
    throw new Error(`Anthropic returned ${aiResponse.status}: ${text}`);
  }

  const payload = await aiResponse.json();
  const text = (payload.content || [])
    .map((part) => part.type === "text" ? part.text : "")
    .join("")
    .trim();
  if (!text) throw new Error("Anthropic returned no JSON text.");
  return parseJsonObject(text);
}

async function enrichStandardsWithOpenAi(sourceSnapshots, checkedAt) {
  const prompt = buildStandardsPrompt(sourceSnapshots, checkedAt);
  const aiResponse = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
      input: prompt,
      text: { format: { type: "json_object" } }
    })
  });

  if (!aiResponse.ok) {
    const text = await aiResponse.text();
    throw new Error(`OpenAI returned ${aiResponse.status}: ${text}`);
  }

  const payload = await aiResponse.json();
  const text = payload.output_text || payload.output?.flatMap((item) => item.content || []).map((part) => part.text || "").join("");
  if (!text) throw new Error("OpenAI returned no JSON text.");
  return parseJsonObject(text);
}

function buildStandardsPrompt(sourceSnapshots, checkedAt) {
  return `Update a standards/regulations library using source pages fetched live by the backend.

Checked at: ${checkedAt}

Source snapshots:
${JSON.stringify(sourceSnapshots, null, 2)}

Return compact valid JSON only. Do not include markdown, comments, or trailing commas.

Return this exact top-level shape:
{
  "status": "completed",
  "checkedAt": "${checkedAt}",
  "standards": [
    {
      "name": "standard or regulation name",
      "domain": "Cybersecurity | Functional Safety | ATEX | Regulation | Market Access",
      "sector": "sector",
      "markets": ["Global"],
      "topics": ["topic"],
      "description": "one or two plain-English sentences explaining what it is for",
      "status": "Watch | Review | Monitor",
      "sourceUrl": "https://...",
      "sourceTitle": "title from source",
      "sourceCheckedAt": "${checkedAt}",
      "sourceStatus": "source_fetched | source_http_... | source_fetch_failed: ... | missing_source_url",
      "sourceEvidence": "short note describing what source material was available",
      "changes": [
        {
          "date": "${checkedAt.slice(0, 10)}",
          "title": "AI source review",
          "impact": "Low | Review | High",
          "url": "https://...",
          "summary": "what changed or what the latest public source review found"
        }
      ]
    }
  ]
}

Rules:
- Use only the source extracts and existing record fields. Do not invent publication dates or official changes.
- If the source extract does not state a new amendment/change, create one change entry titled "AI source review" with impact "Review" and summarize what the current source page says.
- If the source could not be fetched, keep the prior description if present and set sourceEvidence to the failure reason.
- Keep descriptions short, practical, and useful for customer-facing assurance teams.
- Keep names stable unless the source clearly indicates the better official name.
- Preserve sourceUrl from the input whenever present.`;
}

function deterministicStandardsUpdate(sourceSnapshots, checkedAt) {
  return {
    status: "source_review_without_ai",
    checkedAt,
    standards: sourceSnapshots.map((standard) => ({
      name: standard.name,
      domain: standard.domain,
      sector: standard.sector,
      markets: standard.markets,
      topics: standard.topics,
      description: standard.description,
      status: standard.status,
      sourceUrl: standard.sourceUrl,
      sourceTitle: standard.sourceTitle,
      sourceCheckedAt: standard.sourceCheckedAt,
      sourceStatus: standard.sourceStatus,
      sourceEvidence: standard.sourceStatus === "source_fetched"
        ? `Fetched live source page${standard.sourceTitle ? `: ${standard.sourceTitle}` : ""}. AI key not configured, so the existing description was retained.`
        : `Source review could not fetch the page: ${standard.sourceStatus}.`,
      changes: [
        {
          date: checkedAt.slice(0, 10),
          title: "Live source review",
          impact: standard.sourceStatus === "source_fetched" ? "Review" : "Low",
          url: standard.sourceUrl,
          summary: standard.sourceStatus === "source_fetched"
            ? `The backend fetched the official/reference source for ${standard.name}. Add an AI key to summarize public updates from the source content.`
            : `The backend attempted to check ${standard.name}, but the source was not available to the Lambda fetcher.`
        },
        ...standard.changes
      ].slice(0, 6)
    }))
  };
}

async function saveStandards(standards, checkedAt, status) {
  if (!process.env.STANDARDS_TABLE) return;

  const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
  const { DynamoDBDocumentClient, PutCommand } = await import("@aws-sdk/lib-dynamodb");
  const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));

  await Promise.all(standards.map((standard) => dynamo.send(new PutCommand({
    TableName: process.env.STANDARDS_TABLE,
    Item: {
      pk: `STANDARD#${slug(standard.name)}`,
      sk: `SOURCE_REVIEW#${checkedAt}`,
      ...standard,
      enrichment_status: status,
      checked_at: checkedAt
    }
  }))));
}

async function runScheduledStandardsWatch(body = {}) {
  const actor = actorFrom(body);
  const loaded = await loadAppState();
  let state = sanitizeAppState(loaded.state || {});
  const checkedAt = new Date().toISOString();
  const schedule = state.watchSchedule || {};
  const standardsToCheck = schedule.includeStandards === false ? [] : state.standards;

  if (!standardsToCheck.length) {
    state = withAudit(state, auditEvent(
      "standards.watch.noop",
      { type: "standards", name: "Daily watch" },
      "Scheduled watch ran, but there were no standards to check.",
      actor
    ));
    await saveAppState(state);
    return {
      status: "no_standards",
      checkedAt,
      updatedStandards: 0,
      impactMatches: 0,
      delivery: { channels: [], status: "skipped" }
    };
  }

  const update = await enrichStandardsUpdate({
    standards: standardsToCheck,
    source: body.source || "scheduled-watch"
  });
  const updatedStandards = mergeStandardRecords(state.standards, update.standards || []);
  state = {
    ...state,
    standards: updatedStandards,
    watchSchedule: {
      ...schedule,
      lastRunAt: update.checkedAt || checkedAt,
      lastRunStatus: update.status || "completed"
    }
  };
  const impactMatches = buildImpactMatches(state.customers, state.standards);
  state = withAudit(state, auditEvent(
    "standards.watch.completed",
    { type: "standards", name: "Daily watch" },
    `Checked ${update.standards?.length || 0} standards and found ${impactMatches.length} customer-standard change matches.`,
    actor,
    { impactMatches: impactMatches.length }
  ));
  await saveAppState(state);

  const delivery = await deliverScheduledSummary(update, impactMatches, state);
  return {
    status: "completed",
    checkedAt: update.checkedAt || checkedAt,
    updatedStandards: update.standards?.length || 0,
    impactMatches: impactMatches.length,
    delivery
  };
}

function mergeStandardRecords(existing = [], incoming = []) {
  const merged = existing.map((standard) => ({ ...standard }));
  incoming.forEach((updated) => {
    const index = merged.findIndex((standard) => normalize(standard.name) === normalize(updated.name));
    if (index >= 0) {
      merged[index] = {
        ...merged[index],
        ...updated,
        name: merged[index].name || updated.name,
        markets: normalizeList(updated.markets?.length ? updated.markets : merged[index].markets),
        topics: normalizeList(updated.topics?.length ? updated.topics : merged[index].topics),
        changes: mergeChangeLists(updated.changes, merged[index].changes)
      };
    } else {
      merged.push(updated);
    }
  });
  return merged;
}

function mergeChangeLists(newChanges = [], oldChanges = []) {
  const merged = [];
  [...normalizeList(newChanges), ...normalizeList(oldChanges)].forEach((change) => {
    const key = normalize(`${change.date || ""} ${change.title || ""} ${change.url || ""} ${change.summary || ""}`);
    if (!key || merged.some((item) => normalize(`${item.date || ""} ${item.title || ""} ${item.url || ""} ${item.summary || ""}`) === key)) return;
    merged.push(change);
  });
  return merged.slice(0, 8);
}

function customerStandardNames(customer = {}) {
  const projectStandards = Array.isArray(customer.projects)
    ? customer.projects.flatMap((project) => normalizeList(project.standards))
    : [];
  return Array.from(new Set([
    ...normalizeList(customer.knownStandards),
    ...normalizeList(customer.guessedStandards),
    ...normalizeList(customer.likelyStandards).map((item) => typeof item === "string" ? item : item.name),
    ...projectStandards
  ].filter(Boolean)));
}

function buildImpactMatches(customers = [], standards = []) {
  const changedStandards = standards.filter((standard) => normalizeList(standard.changes).length);
  const matches = [];
  customers.forEach((customer) => {
    const names = customerStandardNames(customer).map(normalize);
    changedStandards.forEach((standard) => {
      if (!names.includes(normalize(standard.name))) return;
      matches.push({
        customerName: customer.name,
        customerKey: slug(customer.name || "customer"),
        standard: standard.name,
        owner: customer.owner || "NA team",
        watched: customer.hypercare === "Active",
        latestChange: normalizeList(standard.changes)[0] || null
      });
    });
  });
  return matches;
}

async function deliverScheduledSummary(update, impactMatches, state) {
  const text = [
    "TRNA CCB daily standards watch completed.",
    `Checked standards: ${update.standards?.length || 0}.`,
    `Customer-standard impact matches: ${impactMatches.length}.`,
    impactMatches.slice(0, 8).map((item) => `- ${item.customerName}: ${item.standard}${item.watched ? "" : " (not on notification watch)"}`).join("\n")
  ].filter(Boolean).join("\n");
  return deliverNotification({
    subject: "TRNA CCB daily standards watch",
    text,
    to: process.env.DEFAULT_NOTIFICATION_EMAIL || process.env.NOTIFICATION_TO_EMAIL || "",
    state
  });
}

async function sendNotificationTask(body = {}) {
  const actor = actorFrom(body);
  const loaded = await loadAppState();
  let state = sanitizeAppState(loaded.state || {});
  const requestId = body.requestId || body.taskRequestId;
  const requestIndex = state.adminRequests.findIndex((request) => request.id === requestId);
  if (requestIndex < 0) {
    const error = new Error("Notification task was not found in shared state.");
    error.statusCode = 404;
    throw error;
  }
  const request = state.adminRequests[requestIndex];
  if (request.type !== "notify-customer") {
    const error = new Error("The selected item is not a customer notification task.");
    error.statusCode = 400;
    throw error;
  }
  const owner = state.users.find((user) => normalize(user.name) === normalize(request.owner));
  const text = [
    `Customer notification task: ${request.customerName || "Customer"}`,
    `Standard: ${request.standard || "Not specified"}`,
    `Priority: ${request.priority || "Medium"}`,
    `Due: ${request.dueDate || "Not set"}`,
    `Owner: ${request.owner || "NA team"}`,
    "",
    request.reason || "Review the saved impact review in TRNA CCB."
  ].join("\n");
  const delivery = await deliverNotification({
    subject: `TRNA CCB customer task: ${request.customerName || "Customer"} / ${request.standard || "Standard"}`,
    text,
    to: owner?.email || process.env.DEFAULT_NOTIFICATION_EMAIL || process.env.NOTIFICATION_TO_EMAIL || "",
    state
  });

  const updatedRequest = {
    ...request,
    deliveryStatus: delivery.status,
    deliveryChannels: delivery.channels,
    deliveryMessage: delivery.message || "",
    deliveredAt: delivery.status === "sent" ? new Date().toISOString() : request.deliveredAt || "",
    taskStatus: delivery.status === "sent" ? "Sent" : request.taskStatus || "Open"
  };
  state.adminRequests[requestIndex] = updatedRequest;
  state = withAudit(state, auditEvent(
    "notification.sent",
    { type: "customer", name: request.customerName || "Customer" },
    delivery.status === "sent"
      ? `Sent customer notification task for ${request.standard || "standard"} through ${delivery.channels.join(", ")}.`
      : `Notification delivery attempted for ${request.standard || "standard"}: ${delivery.message || "not configured"}.`,
    actor,
    { requestId: request.id, deliveryStatus: delivery.status }
  ));
  await saveAppState(state);
  return {
    status: delivery.status,
    delivery,
    request: updatedRequest
  };
}

async function deliverNotification({ subject, text, to }) {
  const results = [];
  if (process.env.TEAMS_WEBHOOK_URL) {
    results.push(await sendTeamsNotification(subject, text));
  }
  if (process.env.NOTIFICATION_FROM_EMAIL && to) {
    results.push(await sendEmailNotification(subject, text, to));
  }
  if (!results.length) {
    return {
      status: "not_configured",
      channels: [],
      message: "Set TEAMS_WEBHOOK_URL and/or NOTIFICATION_FROM_EMAIL plus a recipient email to enable delivery."
    };
  }
  const failed = results.filter((item) => item.status !== "sent");
  return {
    status: failed.length === results.length ? "failed" : "sent",
    channels: results.filter((item) => item.status === "sent").map((item) => item.channel),
    details: results,
    message: failed.map((item) => item.message).filter(Boolean).join("; ")
  };
}

async function sendTeamsNotification(subject, text) {
  try {
    const result = await fetch(process.env.TEAMS_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: `**${subject}**\n\n${text}` })
    });
    if (!result.ok) throw new Error(`Teams webhook returned ${result.status}: ${await result.text()}`);
    return { channel: "teams", status: "sent" };
  } catch (error) {
    return { channel: "teams", status: "failed", message: error.message };
  }
}

async function sendEmailNotification(subject, text, to) {
  try {
    const { SESv2Client, SendEmailCommand } = await import("@aws-sdk/client-sesv2");
    const client = new SESv2Client({});
    await client.send(new SendEmailCommand({
      FromEmailAddress: process.env.NOTIFICATION_FROM_EMAIL,
      Destination: { ToAddresses: String(to).split(",").map((item) => item.trim()).filter(Boolean) },
      Content: {
        Simple: {
          Subject: { Data: subject },
          Body: { Text: { Data: text } }
        }
      }
    }));
    return { channel: "email", status: "sent", to };
  } catch (error) {
    return { channel: "email", status: "failed", message: error.message };
  }
}

function buildEnrichmentPrompt(body, standards) {
  return `You enrich global B2B customer profiles for a testing, inspection, certification, cybersecurity, functional safety, and market access team.

Return compact valid JSON only. Do not include markdown, comments, or trailing commas. Use double quotes for every property name and string value.

Customer input:
${JSON.stringify(body, null, 2)}

Available standards and regulations:
${JSON.stringify(standards, null, 2)}

Return this exact top-level shape:
{
  "status": "completed",
  "candidates": [
    {
      "name": "possible legal or brand entity",
      "website": "https://...",
      "headquarters": "city, country",
      "sector": "sector",
      "summary": "why this may be the intended customer",
      "confidence": "low|medium|high"
    }
  ],
  "customer": {
    "name": "confirmed customer name",
    "website": "https://...",
    "headquarters": "city, country",
    "sector": "sector",
    "subSector": "sub-sector",
    "size": "startup | mid-market | enterprise | global enterprise",
    "employeeEstimate": "estimated employee count or range with source caveat",
    "revenueEstimate": "estimated annual revenue or range with source caveat",
    "yearFounded": "year founded or Unknown - verify",
    "ownership": "public | private | subsidiary | Unknown - verify",
    "keyProducts": ["main product or service lines"],
    "targetMarkets": ["markets or regions served"],
    "subsidiaries": ["relevant subsidiaries, business units, or legal entities if known"],
    "markets": ["North America", "EU", "Global"],
    "summary": "two sentence plain-English profile",
    "knownStandards": [],
    "guessedStandards": [],
    "likelyStandards": [
      { "name": "standard", "domain": "domain", "confidence": "low|medium|high", "why": "short reason" }
    ],
    "hypercare": "Active",
    "owner": "NA team",
    "actions": ["10 concise engagement, cross-sell, or upsell ideas"],
    "evidenceNotes": ["assumptions and source-review notes"],
    "sourceNotes": ["where key facts appear to come from or what must be verified"],
    "confidence": "low|medium|medium-high|high"
  }
}

Rules:
- Users are NA-based, but customers may be global and may have EU, UK, China, or other subsidiaries.
- If the customer name is ambiguous, abbreviated, or low-confidence, return 2 to 5 candidates. If the intended company is obvious, return one candidate matching the final customer.
- Provide a practical business profile, not only compliance guesses. Put employee estimate, revenue estimate, founded year, ownership, products/services, subsidiaries, and markets in their dedicated JSON fields, not only inside the summary.
- Keep summary to one or two short plain-English sentences. Do not bury employee count, revenue, or source caveats in the summary if a dedicated field exists.
- If a fact is uncertain, use "Unknown - verify" or an explicit range instead of inventing precision.
- Never state guessed standards as confirmed requirements.
- Include exactly 10 actions.
- Prefer standards relevant to cybersecurity, functional safety, ATEX/explosive atmospheres, OT security, connected products, automotive, medical devices, financial resilience, and global market access.`;
}

function deterministicEnrichment(body) {
  const name = String(body.confirmedEntity?.name || body.name).trim();
  const inputMarkets = normalizeList(body.markets);
  const text = normalize(`${name} ${body.sector || ""} ${body.notes || ""} ${inputMarkets.join(" ")}`);
  const sector = body.sector || inferSector(text);
  const markets = Array.from(new Set([...(inputMarkets.length ? inputMarkets : ["North America"]), ...(text.includes("global") ? ["Global"] : [])]));
  const likelyStandards = standardsFor(sector, markets);

  return {
    status: "completed_rule_based_fallback",
    notice: "Rule-based fallback was used. Configure or fix the AI provider before treating this as customer intelligence.",
    candidates: [],
    customer: {
      name,
      website: body.website || body.confirmedEntity?.website || "",
      headquarters: body.confirmedEntity?.headquarters || "Unknown - verify with customer",
      sector,
      subSector: sectorSubSector(sector),
      size: body.size || (markets.includes("Global") ? "Global enterprise" : "Enterprise"),
      employeeEstimate: body.size ? employeeEstimateFor(body.size, sector, markets) : "Unknown - verify with AI or customer source",
      revenueEstimate: body.size ? revenueEstimateFor(body.size) : "Unknown - verify with AI or customer source",
      yearFounded: "Unknown - verify",
      ownership: "Unknown - verify",
      keyProducts: keyProductsFor(sector),
      targetMarkets: markets,
      subsidiaries: [],
      markets,
      summary: `${name} was not enriched by AI. The fallback only matched the entered name and market hints to a broad ${sector} profile, so verify the entity before saving.`,
      knownStandards: [],
      guessedStandards: likelyStandards.map((item) => item.name),
      likelyStandards,
      hypercare: "Active",
      owner: "NA team",
      actions: engagementActions(sector, markets, name),
      evidenceNotes: [
        "Rule-based fallback was used because the AI provider was not available.",
        "Confirm customer facts, subsidiaries, and standards before outreach."
      ],
      sourceNotes: [
        "Fallback profile uses user-entered hints and sector logic only. Configure or repair Claude for AI-enriched business metadata."
      ],
      sourceConfidence: "Rule-based fallback only - AI enrichment did not run",
      confidence: "low"
    }
  };
}

function employeeEstimateFor(size, sector, markets = []) {
  const text = normalize(`${size} ${sector} ${markets.join(" ")}`);
  if (text.includes("global enterprise")) return "10,000+ employees";
  if (text.includes("enterprise")) return "1,000-10,000 employees";
  if (text.includes("mid market") || text.includes("mid-market")) return "250-1,000 employees";
  if (text.includes("small")) return "50-250 employees";
  if (text.includes("startup")) return "10-100 employees";
  if (text.includes("automotive") || text.includes("industrial")) return "500-5,000 employees";
  return "Unknown - verify";
}

function revenueEstimateFor(size) {
  const text = normalize(size);
  if (text.includes("global enterprise")) return "$10B+ annual revenue";
  if (text.includes("enterprise")) return "$1B-$10B annual revenue";
  if (text.includes("mid market") || text.includes("mid-market")) return "$50M-$1B annual revenue";
  if (text.includes("small")) return "$10M-$50M annual revenue";
  if (text.includes("startup")) return "Pre-revenue to $25M annual revenue";
  return "Unknown - verify";
}

function keyProductsFor(sector) {
  const map = {
    "Automotive": ["connected vehicle systems", "mobility software", "vehicle components"],
    "Industrial / OT": ["automation systems", "control software", "connected industrial equipment"],
    "Medical Devices": ["connected medical devices", "regulated software", "diagnostic systems"],
    "Financial Services": ["digital services", "ICT operations", "customer platforms"],
    "ICT / Connected Products": ["connected products", "software platforms", "cloud-enabled services"]
  };
  return map[sector] || ["products and services to verify"];
}

function inferSector(text) {
  if (text.includes("vehicle") || text.includes("automotive")) return "Automotive";
  if (text.includes("industrial") || text.includes("automation") || text.includes("plant") || text.includes("ot")) return "Industrial / OT";
  if (text.includes("medical") || text.includes("health")) return "Medical Devices";
  if (text.includes("finance") || text.includes("bank")) return "Financial Services";
  return "ICT / Connected Products";
}

function sectorSubSector(sector) {
  const map = {
    "Automotive": "Connected vehicles, software-defined vehicle systems, suppliers, or manufacturing",
    "Industrial / OT": "Industrial automation, plant systems, process safety, or OT cybersecurity",
    "Medical Devices": "Connected medical technology, regulated software, or product security",
    "Financial Services": "Digital operational resilience, third-party ICT risk, and information security",
    "ICT / Connected Products": "Connected products, software, cloud, or digital infrastructure"
  };
  return map[sector] || "General assurance and market access";
}

function standardsFor(sector, markets) {
  const list = [];
  if (sector === "Automotive") list.push("ISO/SAE 21434", "UNECE R155 / R156", "ISO 26262", "TISAX", "IEC 62443");
  if (sector === "Industrial / OT") list.push("IEC 62443", "IEC 61508", "IEC 61511", "ISO 13849", "ATEX Directive 2014/34/EU", "ATEX Workplace Directive 1999/92/EC", "ISO 27001 / 27002");
  if (sector === "Medical Devices") list.push("UL 2900", "ISO 27001 / 27002", "EU Cyber Resilience Act");
  if (sector === "Financial Services") list.push("ISO 27001 / 27002", "NIS2");
  if (sector === "ICT / Connected Products") list.push("EU Cyber Resilience Act", "ISO 27001 / 27002", "NIST SP 800-115", "UL 2900");
  if (markets.includes("EU")) list.push("NIS2", "EU Cyber Resilience Act", "UKCA / CE Market Access");
  if (markets.includes("UK")) list.push("UKCA / CE Market Access");
  return Array.from(new Set(list)).slice(0, 8).map((name) => ({
    name,
    confidence: "medium",
    domain: domainFor(name),
    why: `${name} is a plausible fit for ${sector} customers with ${markets.join(", ")} exposure. Confirm with the delivery team before treating it as required.`
  }));
}

function domainFor(name) {
  if (/ATEX|2014\/34|1999\/92|explosive atmosphere/i.test(name)) return "ATEX";
  if (/61508|61511|13849|26262/.test(name)) return "Functional Safety";
  if (/DORA|NIS2|Resilience|R155|R156/.test(name)) return "Regulation";
  if (/UKCA|CE/.test(name)) return "Market Access";
  return "Cybersecurity";
}

function engagementActions(sector, markets, name) {
  const base = [
    `Confirm ${name}'s entity, subsidiaries, markets, and product lines before outreach.`,
    "Map known standards from past projects into hypercare.",
    "Prepare a two-page customer briefing with confirmed facts and AI assumptions separated."
  ];
  const sectorActions = {
    "Automotive": [
      "Discuss ISO/SAE 21434 readiness for connected-vehicle programs.",
      "Connect functional safety and cybersecurity topics where safety depends on software or connectivity.",
      "Offer TISAX or supplier readiness support for European OEM programs."
    ],
    "Industrial / OT": [
      "Position IEC 62443 assessment for OT environments or automation products.",
      "Discuss IEC 61508 or IEC 61511 if safety instrumented systems are involved.",
      "Offer plant resilience, remote assessment, or OT security testing support."
    ],
    "Medical Devices": [
      "Review connected-product cybersecurity evidence and vulnerability handling.",
      "Discuss product security testing for network-connectable systems.",
      "Check market access and privacy expectations for regulated health technology."
    ]
  };
  const marketActions = markets.includes("EU")
    ? ["Check EU regulatory exposure, especially CRA, NIS2, CE, or sector-specific requirements."]
    : ["Check whether global exports require local conformity, test marks, or certification paths."];
  return [...base, ...(sectorActions[sector] || []), ...marketActions, "Identify one immediate gap assessment and one longer-term certification opportunity.", "Create a follow-up plan for account owner and delivery lead."].slice(0, 10);
}

function normalize(value) {
  return String(value || "").toLowerCase();
}

function normalizeList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.trim()) return value.split(",").map((item) => item.trim()).filter(Boolean);
  return [];
}

function slug(value) {
  return String(value || "customer").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function response(statusCode, body) {
  return {
    statusCode,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json"
    },
    body: statusCode === 204 ? "" : JSON.stringify(body)
  };
}
