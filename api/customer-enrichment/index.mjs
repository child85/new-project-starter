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

    if (body.task === "impact-review") {
      const result = await enrichImpactReview(body);
      return response(200, result);
    }

    if (!body.name || !String(body.name).trim()) {
      return response(400, { error: "Customer name is required." });
    }

    if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) {
      return response(503, {
        status: "ai_provider_missing",
        error: "AI provider is not configured.",
        detail: "Add ANTHROPIC_API_KEY or OPENAI_API_KEY to the Lambda environment before customer enrichment can run."
      });
    }

    let result;
    try {
      result = process.env.ANTHROPIC_API_KEY
        ? await enrichWithClaude(body)
        : await enrichWithAi(body);
    } catch (aiError) {
      return response(502, {
        status: "ai_provider_error",
        error: "AI enrichment failed.",
        detail: aiError.message
      });
    }

    if (!result?.customer?.name) {
      return response(502, {
        status: "ai_provider_error",
        error: "AI enrichment returned an incomplete customer profile.",
        detail: "The backend did not receive a usable customer profile from the AI provider."
      });
    }

    await saveCustomerProfile(result.customer, result.status || "completed");

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
        : "not configured",
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
    videos: [],
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
    videos: Array.isArray(state.videos) ? state.videos.slice(0, 3) : [],
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
      max_tokens: Number(process.env.ANTHROPIC_MAX_TOKENS || 4200),
      temperature: 0.2,
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
  const candidates = [];
  candidates.push(trimmed);

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1].trim());

  const extracted = extractFirstJsonObject(trimmed);
  if (extracted) candidates.push(extracted);

  for (const candidate of candidates) {
    const parsed = tryParseJson(candidate);
    if (parsed) return parsed;
  }

  for (const candidate of candidates) {
    const repaired = repairAiJson(candidate);
    const parsed = tryParseJson(repaired);
    if (parsed) return parsed;
  }

  throw new Error("AI provider returned text that was not valid JSON.");
}

function tryParseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function extractFirstJsonObject(text) {
  const start = text.indexOf("{");
  if (start < 0) return "";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = inString;
      continue;
    }
    if (char === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth === 0) return text.slice(start, index + 1);
  }
  const end = text.lastIndexOf("}");
  return end > start ? text.slice(start, end + 1) : "";
}

function repairAiJson(text) {
  return String(text || "")
    .replace(/^\uFEFF/, "")
    .replace(/[“”]/g, "\"")
    .replace(/[‘’]/g, "'")
    .replace(/,\s*([}\]])/g, "$1")
    .replace(/("(?:[^"\\]|\\.)*")(\s*\n\s*)(")/g, "$1,$2$3")
    .replace(/([}\]])(\s*\n\s*)(")/g, "$1,$2$3")
    .replace(/(")(\s*\n\s*)([{\[])/g, "$1,$2$3")
    .replace(/([}\]])(\s*\n\s*)([{\[])/g, "$1,$2$3");
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
  return `Update or draft a standards/regulations library using source pages fetched live by the backend when available.

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
- When sourceUrl is missing or sourceStatus is "missing_source_url", draft a useful first profile from the standard/regulation name and widely known public information. In that case:
  - Set sourceStatus to "ai_draft_needs_source".
  - Set sourceEvidence to "AI drafted from the standard name; add an official source URL before treating this as source-verified."
  - Suggest the most likely official sourceUrl only when you are confident it is a stable publisher page, such as iso.org, iec.ch, eur-lex.europa.eu, unece.org, nist.gov, ul.com, or gov.uk.
  - Do not create a fake publication change. Use a change entry titled "Source needed" with impact "Low" and explain that no official source has been checked yet.
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

async function enrichImpactReview(body) {
  const input = sanitizeImpactReviewInput(body);
  if (!input.customer.name || !input.standard.name) {
    return {
      status: "invalid_request",
      error: "Customer and standard are required for impact review."
    };
  }

  try {
    if (process.env.ANTHROPIC_API_KEY) {
      return normalizeImpactRecommendation(await enrichImpactWithClaude(input), input);
    }
    if (process.env.OPENAI_API_KEY) {
      return normalizeImpactRecommendation(await enrichImpactWithOpenAi(input), input);
    }
  } catch (error) {
    return {
      status: "ai_provider_error",
      error: "AI impact review failed.",
      detail: error.message
    };
  }

  return {
    status: "ai_provider_missing",
    error: "AI provider is not configured.",
    detail: "Add ANTHROPIC_API_KEY or OPENAI_API_KEY to generate customer-specific impact reviews."
  };
}

function sanitizeImpactReviewInput(body) {
  return {
    customer: {
      name: String(body.customer?.name || "").trim(),
      website: String(body.customer?.website || "").trim(),
      headquarters: String(body.customer?.headquarters || "").trim(),
      sector: String(body.customer?.sector || "").trim(),
      subSector: String(body.customer?.subSector || "").trim(),
      markets: normalizeList(body.customer?.markets),
      employeeEstimate: String(body.customer?.employeeEstimate || "").trim(),
      revenueEstimate: String(body.customer?.revenueEstimate || "").trim(),
      keyProducts: normalizeList(body.customer?.keyProducts),
      subsidiaries: normalizeList(body.customer?.subsidiaries),
      knownStandards: normalizeList(body.customer?.knownStandards),
      guessedStandards: normalizeList(body.customer?.guessedStandards),
      projects: Array.isArray(body.customer?.projects) ? body.customer.projects.slice(0, 10).map((project) => ({
        name: String(project.name || "").trim(),
        type: String(project.type || "").trim(),
        status: String(project.status || "").trim(),
        date: String(project.date || "").trim(),
        standards: normalizeList(project.standards),
        notes: String(project.notes || "").trim()
      })) : []
    },
    standard: {
      name: String(body.standard?.name || "").trim(),
      domain: String(body.standard?.domain || "").trim(),
      sector: String(body.standard?.sector || "").trim(),
      markets: normalizeList(body.standard?.markets),
      topics: normalizeList(body.standard?.topics),
      description: String(body.standard?.description || "").trim(),
      sourceUrl: String(body.standard?.sourceUrl || "").trim(),
      internalNotes: String(body.standard?.internalNotes || "").trim()
    },
    change: {
      title: String(body.change?.title || "Public change").trim(),
      date: String(body.change?.date || "").trim(),
      summary: String(body.change?.summary || "").trim(),
      impact: String(body.change?.impact || "Review").trim(),
      url: String(body.change?.url || body.standard?.sourceUrl || "").trim()
    },
    existingReview: body.existingReview || null
  };
}

async function enrichImpactWithClaude(input) {
  const aiResponse = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || "claude-3-5-haiku-20241022",
      max_tokens: 1700,
      system: "You create customer-specific standards-change impact reviews for assurance consultants. Return only compact valid JSON.",
      messages: [{ role: "user", content: buildImpactReviewPrompt(input) }]
    })
  });
  if (!aiResponse.ok) throw new Error(`Anthropic returned ${aiResponse.status}: ${await aiResponse.text()}`);
  const payload = await aiResponse.json();
  const text = (payload.content || []).map((part) => part.type === "text" ? part.text : "").join("").trim();
  if (!text) throw new Error("Anthropic returned no JSON text.");
  return parseJsonObject(text);
}

async function enrichImpactWithOpenAi(input) {
  const aiResponse = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
      input: buildImpactReviewPrompt(input),
      text: { format: { type: "json_object" } }
    })
  });
  if (!aiResponse.ok) throw new Error(`OpenAI returned ${aiResponse.status}: ${await aiResponse.text()}`);
  const payload = await aiResponse.json();
  const text = payload.output_text || payload.output?.flatMap((item) => item.content || []).map((part) => part.text || "").join("");
  if (!text) throw new Error("OpenAI returned no JSON text.");
  return parseJsonObject(text);
}

function buildImpactReviewPrompt(input) {
  return `Create a specific customer impact review from a standards-change note.

Return compact valid JSON only. Do not include markdown.

Customer:
${JSON.stringify(input.customer, null, 2)}

Standard:
${JSON.stringify(input.standard, null, 2)}

Specific change note:
${JSON.stringify(input.change, null, 2)}

Return this exact shape:
{
  "status": "completed",
  "level": "Low | Medium | High",
  "decision": "Relevant | Not relevant | Needs more review",
  "priority": "Low | Medium | High",
  "specificChange": "plain-English statement of what changed, based only on the change note",
  "customerImpact": "specific impact for this customer's products, markets, projects, or likely obligations",
  "whyThisCustomer": ["2-5 concrete reasons tied to customer fields, projects, markets, or standards"],
  "affectedAreas": ["products/projects/markets/evidence areas likely affected"],
  "recommendedActions": ["3-6 concrete consultant next steps"],
  "customerQuestions": ["3-5 questions to validate with the customer"],
  "notificationDraft": "short customer-owner notification draft",
  "reviewNote": "ready-to-save internal review note"
}

Rules:
- Do not say the customer is affected merely because the standard changed. Tie impact to confirmed/project standards first, then guessed standards, markets, sector, products, and subsidiaries.
- If the change note is only a watch item or not a real public change, say that clearly in specificChange and set decision to "Needs more review" unless project evidence makes it relevant.
- If the change note says no official amendment/change has been published yet, state that no customer notification is needed until an actual public change is saved.
- Keep it practical for a consultant deciding whether to notify a customer owner.
- Separate known facts from assumptions.`;
}

function normalizeImpactRecommendation(result, input) {
  const fallback = deterministicImpactRecommendation(input);
  return {
    status: result.status || "completed",
    level: choose(result.level, fallback.level),
    decision: choose(result.decision, fallback.decision),
    priority: choose(result.priority, fallback.priority),
    specificChange: choose(result.specificChange, fallback.specificChange),
    customerImpact: choose(result.customerImpact, fallback.customerImpact),
    whyThisCustomer: normalizeList(result.whyThisCustomer).length ? normalizeList(result.whyThisCustomer).slice(0, 5) : fallback.whyThisCustomer,
    affectedAreas: normalizeList(result.affectedAreas).length ? normalizeList(result.affectedAreas).slice(0, 6) : fallback.affectedAreas,
    recommendedActions: normalizeList(result.recommendedActions).length ? normalizeList(result.recommendedActions).slice(0, 6) : fallback.recommendedActions,
    customerQuestions: normalizeList(result.customerQuestions).length ? normalizeList(result.customerQuestions).slice(0, 5) : fallback.customerQuestions,
    notificationDraft: choose(result.notificationDraft, fallback.notificationDraft),
    reviewNote: choose(result.reviewNote, fallback.reviewNote)
  };
}

function deterministicImpactRecommendation(input) {
  const confirmed = input.customer.knownStandards.some((name) => normalize(name) === normalize(input.standard.name));
  const guessed = input.customer.guessedStandards.some((name) => normalize(name) === normalize(input.standard.name));
  const projects = input.customer.projects.filter((project) => project.standards.some((name) => normalize(name) === normalize(input.standard.name)));
  const text = normalize(`${input.change.title} ${input.change.summary} ${input.change.impact}`);
  const isWatchOnly = isMonitoringOnlyChange(input.change);
  const signalCount = ["shall", "must", "deadline", "effective", "mandatory", "new requirement", "certification", "type approval", "safety", "cybersecurity"].filter((signal) => text.includes(signal)).length;
  const level = !isWatchOnly && (confirmed || projects.length || signalCount >= 3) ? "High" : signalCount || guessed ? "Medium" : "Low";
  const decision = isWatchOnly ? "Needs more review" : confirmed || projects.length || guessed ? "Relevant" : "Needs more review";
  const projectNames = projects.map((project) => project.name).filter(Boolean);
  const specificChange = input.change.summary
    ? `${input.change.title}: ${input.change.summary}`
    : `${input.change.title || input.standard.name} has a saved change note, but no detailed change summary has been captured yet.`;
  const customerFit = [
    confirmed ? `${input.standard.name} is saved as a confirmed customer standard.` : "",
    guessed ? `${input.standard.name} is AI-suggested for this customer.` : "",
    projectNames.length ? `Related saved project or assessment: ${projectNames.join(", ")}.` : "",
    input.customer.markets.length ? `Customer market exposure: ${input.customer.markets.join(", ")}.` : "",
    input.customer.sector ? `Customer sector: ${input.customer.sector}.` : ""
  ].filter(Boolean);
  const customerImpact = isWatchOnly
    ? `This is a monitoring note, not an actual published change. It should not trigger customer outreach until a real amendment, interpretation, or requirement change is saved.`
    : `${input.customer.name} may need a review of affected ${input.customer.sector || "business"} evidence, project claims, or market-access assumptions tied to ${input.standard.name}.`;
  return {
    status: "local_structured_review",
    level,
    decision,
    priority: level,
    specificChange,
    customerImpact,
    whyThisCustomer: customerFit.length ? customerFit : [`${input.standard.name} is linked to this customer through saved or suggested standards.`],
    affectedAreas: [
      ...projectNames.map((name) => `Project / assessment: ${name}`),
      input.customer.keyProducts[0] ? `Product or service area: ${input.customer.keyProducts[0]}` : "Product or service scope needs confirmation",
      input.customer.markets[0] ? `Market exposure: ${input.customer.markets.join(", ")}` : "Market exposure needs confirmation",
      "Customer-facing claims, gap-analysis notes, or certification roadmap"
    ].slice(0, 6),
    recommendedActions: [
      "Read the source link and confirm whether the change note is a real published change or only a watch item.",
      `Check whether ${input.customer.name}'s products, subsidiaries, or delivered projects are in scope.`,
      "Compare the change against saved project standards and any customer commitments.",
      "Decide whether the customer owner needs an internal briefing before external outreach.",
      "Update the customer profile with the final relevance decision."
    ],
    customerQuestions: [
      `Which ${input.customer.sector || "product"} lines rely on ${input.standard.name}?`,
      "Are EU, UK, US, or global market-access claims tied to this standard?",
      "Has the customer already updated internal compliance evidence for this change?",
      "Should TUV Rheinland provide a gap review, assessment update, or hypercare briefing?"
    ],
    notificationDraft: `${input.customer.name}: ${input.standard.name} has a saved change note (${input.change.date || "date unknown"}). Please review whether this affects active projects, delivered evidence, or planned compliance work before customer outreach.`,
    reviewNote: `${level} impact review. Specific change: ${specificChange} Customer impact: ${customerImpact}`
  };
}

function isMonitoringOnlyChange(change) {
  const text = normalize(`${change?.title || ""} ${change?.summary || ""} ${change?.impact || ""}`);
  const signals = [
    "watch item",
    "track public",
    "active monitoring",
    "monitoring for public",
    "potential future changes",
    "no formal amendment",
    "no formal change",
    "no public change",
    "has been published yet",
    "source review",
    "ai source review",
    "current source page says"
  ];
  return signals.some((signal) => text.includes(signal));
}

function choose(value, fallback) {
  return String(value || "").trim() || fallback;
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
    "evidenceNotes": ["specific useful evidence points, such as public filing facts, product lines, market exposure, known certifications, or compliance-relevant business context"],
    "sourceNotes": ["specific source-backed facts that help a consultant trust or challenge the profile"],
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
- Do not include low-value evidence notes such as "subject to change", "verify internally", "customer name from input", "not explicitly confirmed by customer", or generic caveats. Only include notes that add specific source, business, product, market, or standards value.
- Include exactly 10 actions. Keep each action under 150 characters.
- Keep every evidence note and source note under 180 characters.
- Prefer standards relevant to cybersecurity, functional safety, ATEX/explosive atmospheres, OT security, connected products, automotive, medical devices, financial resilience, and global market access.`;
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
