# Assurance Intelligence Hub

Static demo site and backend starter for a TÜV Rheinland-inspired customer and compliance intelligence tool.

## Current site

This project contains a single-page static website in `index.html`. The page is designed to be uploaded directly to an Amazon S3 bucket and served with S3 Static Website Hosting.

The page now includes customer lookup, standards library, and AI source-review workflows:

- resolve a customer name and confirm ambiguous entities
- enrich customer metadata such as website, headquarters, sector, size, markets, and summary
- infer likely standards and compliance exposure
- save customers into a browser-based demo list
- keep hypercare customers attached to standards for future change notifications
- generate top engagement, cross-sell, and upsell ideas
- fetch saved standards source URLs through Lambda and use AI to enrich descriptions, source evidence, and change-review notes

## Architecture

The live demo page is static, but the intended production setup keeps AI keys and customer data on the AWS side:

```mermaid
flowchart LR
    User["NA-based team member<br/>Browser"] --> Site["S3 static website<br/>index.html"]
    Site --> Gateway["API Gateway<br/>/enrich endpoint"]
    Gateway --> Lambda["Lambda<br/>customer-enrichment/index.mjs"]
    Lambda --> Claude["Anthropic Claude<br/>Haiku model"]
    Lambda --> Sources["Official/reference<br/>standards source URLs"]
    Lambda -. optional .-> Dynamo["DynamoDB<br/>customers + standards reviews"]
    Watch["EventBridge daily schedule"] -. future .-> Lambda
    Lambda -. future notifications .-> Notify["Account owner notifications"]
```

In this setup:

- S3 hosts the public website.
- API Gateway provides an HTTPS endpoint for the page to call.
- Lambda runs customer enrichment, standards source fetching, and Claude summarization from the server side.
- DynamoDB can store customer profiles, enrichment runs, standards links, standards source reviews, and hypercare records.
- EventBridge can later call the same Lambda daily for scheduled standards/regulations checks.

This keeps AI keys out of the browser and gives the team a path toward a proper shared database.

The live page still works without the backend by using browser demo enrichment. That is useful for demos, but saved data stays in the user's browser until the backend and database are connected.

## Enrichment backend

A starter Lambda lives in `api/customer-enrichment/`.

The Lambda supports Claude first, OpenAI as an optional fallback, and deterministic demo enrichment if no AI key is configured.

The same endpoint now supports two request types:

- Customer enrichment: send a customer payload with `name`, optional hints, and `standards`.
- Standards enrichment: send `{ "task": "standards-update", "standards": [...] }`. Lambda fetches each saved `sourceUrl`, passes the source extract to AI, and returns enriched standard records with source evidence and change-review notes.

Recommended Lambda environment variables for Claude:

- `ANTHROPIC_API_KEY`: Claude API key. Keep this only in Lambda, never in the website.
- `ANTHROPIC_MODEL`: `claude-3-5-haiku-20241022`.
- `ALLOWED_ORIGIN`: `*` for early testing, or the S3 website URL for tighter access later.

Optional Lambda environment variables:

- `OPENAI_API_KEY`: optional fallback OpenAI API key. If no AI key is set, the Lambda returns deterministic demo enrichment.
- `OPENAI_MODEL`: optional OpenAI model override.
- `CUSTOMER_TABLE`: optional DynamoDB table name for saving enrichment results.
- `STANDARDS_TABLE`: optional DynamoDB table name for saving standards source-review results.
- `STANDARDS_BATCH_SIZE`: optional number of standards to check per run. Default is `6`, maximum is `12`.
- `SOURCE_FETCH_TIMEOUT_MS`: optional source page fetch timeout. Default is `9000`.
- `SOURCE_EXTRACT_CHARS`: optional max characters from each source page sent to AI. Default is `5000`.

After the Lambda is deployed behind API Gateway, paste the API endpoint into the Settings section of the page. Customer lookup will call the AWS backend first and fall back to browser demo enrichment if the endpoint is unavailable. Standards updates require the AWS backend because source fetching and AI keys must not run in the browser.

## AWS setup checklist

1. Host `index.html` in the S3 static website bucket.
2. Create a Lambda function with Node.js and paste in `api/customer-enrichment/index.mjs`.
3. Set the Lambda environment variables for Claude.
4. Create an API Gateway HTTP API route such as `POST /enrich`.
5. Connect that route to the Lambda function.
6. Copy the API Gateway invoke URL into the website's "AI Backend Setup" field.
7. Test a customer lookup from the website.
8. Open Standards Overview and run **Run live AI source update** to enrich standards from their official/reference source URLs.

## API Gateway trigger

The next backend step is connecting the website to Lambda through API Gateway. The repo includes `aws/api-gateway-trigger.yml`, a CloudFormation starter that creates:

- an HTTP API
- a `POST /enrich` route
- a Lambda proxy integration
- the Lambda invoke permission that makes the API Gateway trigger appear on the Lambda function
- an output URL to paste into the website

Manual console path:

1. Open the Lambda function.
2. Choose **Add trigger**.
3. Select **API Gateway**.
4. Choose **Create a new API**.
5. Choose **HTTP API**.
6. Use open access for the first test only.
7. Save the trigger.
8. Copy the API endpoint and add `/enrich` if your route requires it.
9. Paste the final HTTPS URL into the site's **AI Backend Setup** field.

Template path:

1. Open AWS CloudFormation.
2. Create a stack using `aws/api-gateway-trigger.yml`.
3. Enter the existing Lambda function name.
4. Use `*` for `AllowedOrigin` while testing.
5. After the stack completes, copy the `CustomerEnrichmentEndpoint` output.
6. Paste that URL into the site's **AI Backend Setup** field and run **Test saved endpoint**.

## Automatic AWS deployment

This repo includes a GitHub Actions workflow at `.github/workflows/deploy-s3.yml`.

After the GitHub repository has the required secrets, every push to `main` will automatically upload the static site files to the S3 bucket.

Required GitHub repository secrets:

- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `AWS_REGION`
- `S3_BUCKET`

For the current demo bucket, the values are expected to be:

- `AWS_REGION`: `us-east-1`
- `S3_BUCKET`: `nfecke-demo-page-2026`

The AWS user or role behind the access key needs permission to list the bucket, upload objects, delete old objects, and set object content in the S3 website bucket.

The deploy workflow excludes `.github`, `README.md`, `api`, and `aws` so backend source and infrastructure templates are not uploaded as public website files.

## Standards change watch

The repo also includes `.github/workflows/standards-change-watch.yml`, scheduled for a daily run. It is currently a scaffold: the next production step is to call the deployed API endpoint with the saved standards list, compare returned source-review notes against hypercare customers, and notify the responsible account owner.

The current static page stores prototype additions in the browser with local storage. A production version should move standards, customers, hypercare links, enrichment audit runs, and notifications into DynamoDB or another backend database.
