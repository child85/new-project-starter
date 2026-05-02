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
  "IEC 62443",
  "ISO 27001 / 27002",
  "NIST SP 800-115",
  "TISAX",
  "EU Cyber Resilience Act",
  "NIS2",
  "DORA",
  "UL 2900",
  "UKCA / CE Market Access"
];

export async function handler(event) {
  if (event.requestContext?.http?.method === "OPTIONS" || event.httpMethod === "OPTIONS") {
    return response(204, {});
  }

  try {
    const body = parseRequestBody(event);
    if (!body.name || !String(body.name).trim()) {
      return response(400, { error: "Customer name is required." });
    }

    const result = process.env.ANTHROPIC_API_KEY
      ? await enrichWithClaude(body)
      : process.env.OPENAI_API_KEY
        ? await enrichWithAi(body)
        : deterministicEnrichment(body);

    await saveCustomerProfile(result.customer, result.status);

    return response(200, result);
  } catch (error) {
    return response(500, {
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
      system: "You enrich customer profiles for assurance, cybersecurity, functional safety, and market-access teams. Return valid JSON only.",
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

function buildEnrichmentPrompt(body, standards) {
  return `You enrich global B2B customer profiles for a testing, inspection, certification, cybersecurity, functional safety, and market access team.

Return compact valid JSON only. Do not include markdown.

Customer input:
${JSON.stringify(body, null, 2)}

Available standards and regulations:
${JSON.stringify(standards, null, 2)}

Return this exact top-level shape:
{
  "status": "completed",
  "customer": {
    "name": "confirmed customer name",
    "website": "https://...",
    "headquarters": "city, country",
    "sector": "sector",
    "subSector": "sub-sector",
    "size": "startup | mid-market | enterprise | global enterprise",
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
    "confidence": "low|medium|medium-high|high"
  }
}

Rules:
- Users are NA-based, but customers may be global and may have EU, UK, China, or other subsidiaries.
- Never state guessed standards as confirmed requirements.
- Include exactly 10 actions.
- Prefer standards relevant to cybersecurity, functional safety, OT security, connected products, automotive, medical devices, financial resilience, and global market access.`;
}

function deterministicEnrichment(body) {
  const name = String(body.confirmedEntity?.name || body.name).trim();
  const inputMarkets = normalizeList(body.markets);
  const text = normalize(`${name} ${body.sector || ""} ${body.notes || ""} ${inputMarkets.join(" ")}`);
  const sector = body.sector || inferSector(text);
  const markets = Array.from(new Set([...(inputMarkets.length ? inputMarkets : ["North America"]), ...(text.includes("global") ? ["Global"] : [])]));
  const likelyStandards = standardsFor(sector, markets);

  return {
    status: "completed_demo_fallback",
    customer: {
      name,
      website: body.website || body.confirmedEntity?.website || "",
      headquarters: body.confirmedEntity?.headquarters || "Unknown - verify with customer",
      sector,
      subSector: sectorSubSector(sector),
      size: body.size || (markets.includes("Global") ? "Global enterprise" : "Enterprise"),
      markets,
      summary: `${name} appears to fit the ${sector} context with ${markets.join(", ")} exposure. Review these AI-assisted guesses before treating them as confirmed customer intelligence.`,
      knownStandards: [],
      guessedStandards: likelyStandards.map((item) => item.name),
      likelyStandards,
      hypercare: "Active",
      owner: "NA team",
      actions: engagementActions(sector, markets, name),
      evidenceNotes: [
        "Deterministic fallback was used because no Anthropic or OpenAI API key is configured.",
        "Confirm customer facts, subsidiaries, and standards before outreach."
      ],
      confidence: "medium"
    }
  };
}

function inferSector(text) {
  if (text.includes("vehicle") || text.includes("automotive") || text.includes("bmw")) return "Automotive";
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
  if (sector === "Industrial / OT") list.push("IEC 62443", "IEC 61508", "IEC 61511", "ISO 13849", "ISO 27001 / 27002");
  if (sector === "Medical Devices") list.push("UL 2900", "ISO 27001 / 27002", "EU Cyber Resilience Act");
  if (sector === "Financial Services") list.push("DORA", "ISO 27001 / 27002", "NIS2");
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
    ? ["Check EU regulatory exposure, especially CRA, NIS2, DORA, CE, or sector-specific requirements."]
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
