# TRNA Compliance Clipboard

Static frontend and AWS backend starter for the TRNA Compliance Clipboard (`TRNA CCB`).

## Current Site

This project contains a single-page website in `index.html`. The page can be uploaded directly to an Amazon S3 bucket and served with S3 Static Website Hosting.

The hub is intended to help NA-based team members work with global customers:

- enrich customer profiles through the AWS AI backend
- save customer metadata, standards exposure, project history, impact reviews, and notification tasks
- keep a standards library with official source links and last-change notes
- review which customers are tied to which standards
- create customer notification tasks when a standard or regulation changes
- select a current user role, assign owners, and keep an audit trail of key changes

Customer data is no longer seeded with fake saved records. Shared records should load and save through the AWS backend; local browser storage is only used for UI preferences such as the selected endpoint or current user selector.

## Architecture

```mermaid
flowchart LR
    User["Team member<br/>Browser"] --> Site["S3 static website<br/>index.html"]
    Site --> Gateway["API Gateway<br/>POST endpoint"]
    Gateway --> Lambda["Lambda<br/>api/customer-enrichment/index.mjs"]
    Lambda --> Claude["Anthropic Claude<br/>Haiku model"]
    Lambda --> Sources["Official standards<br/>and regulation sources"]
    Lambda --> State["DynamoDB<br/>APP_STATE_TABLE<br/>shared hub state"]
    Lambda -. audit .-> Customers["DynamoDB<br/>CUSTOMER_TABLE"]
    Lambda -. audit .-> Standards["DynamoDB<br/>STANDARDS_TABLE"]
    Watch["GitHub Actions or AWS schedule<br/>daily standards watch"] --> Gateway
    Lambda --> Notify["Teams webhook / SES email<br/>customer notifications"]
```

In this setup:

- S3 hosts the public website.
- API Gateway provides the HTTPS endpoint the page calls.
- Lambda runs customer enrichment, standards source checks, and app-state load/save.
- `APP_STATE_TABLE` is the shared database for the hub state: customers, standards, users, admin requests, impact reviews, tasks, schedule settings, and audit events.
- Optional audit tables can store individual enrichment runs and standards source-review history.
- GitHub Actions or an AWS scheduler can call the same API Gateway endpoint daily for scheduled standards/regulations checks.
- Teams and/or email delivery can send customer notification tasks once the Lambda delivery environment variables are configured.

## Roles and Audit Trail

The website now has three workspace roles:

- `Admin`: manages API endpoint settings, users, schedules, curated standards, and admin requests.
- `Consultant`: adds customers, standards, projects, impact reviews, and customer notification tasks.
- `Viewer`: reviews dashboards and records without saving operational changes.

This is a shared workspace role selector inside the page, not production SSO. For broader rollout, connect AWS Cognito, Microsoft Entra ID, or another identity provider so roles are enforced by sign-in rather than a browser selector.

Key changes are saved into `auditEvents` in `APP_STATE_TABLE` and shown in the Settings audit trail.

## Lambda Environment Variables

Required for usable AI enrichment:

- `ANTHROPIC_API_KEY`: Claude API key. Keep this only in Lambda, never in the website.
- `ANTHROPIC_MODEL`: recommended value `claude-3-5-haiku-20241022`.
- `ALLOWED_ORIGIN`: `*` for early testing, or the S3 website URL for tighter access later.

Required for shared hub storage:

- `APP_STATE_TABLE`: DynamoDB table name used for shared app data.

Create the DynamoDB table with a string partition key named `pk` and a string sort key named `sk`. The Lambda stores the current shared hub state at `APP#assurance-intelligence-hub` / `STATE#current`.

Optional:

- `CUSTOMER_TABLE`: DynamoDB table name for customer enrichment audit records.
- `STANDARDS_TABLE`: DynamoDB table name for standards source-review audit records.
- `TEAMS_WEBHOOK_URL`: optional Microsoft Teams incoming webhook for daily watch summaries and notification tasks.
- `NOTIFICATION_FROM_EMAIL`: optional verified SES sender address for email delivery.
- `DEFAULT_NOTIFICATION_EMAIL` or `NOTIFICATION_TO_EMAIL`: fallback recipient for watch summaries or tasks without an owner email.
- `OPENAI_API_KEY`: optional fallback OpenAI API key.
- `OPENAI_MODEL`: optional OpenAI model override.
- `STANDARDS_BATCH_SIZE`: optional number of standards to check per run. Default is `6`, maximum is `12`.
- `SOURCE_FETCH_TIMEOUT_MS`: optional source page fetch timeout. Default is `9000`.
- `SOURCE_EXTRACT_CHARS`: optional max characters from each source page sent to AI. Default is `5000`.

If `APP_STATE_TABLE` is missing, the website can still test AI enrichment, but it will report that shared storage is not connected. Do not treat browser cache as production storage.

## Backend Request Types

The Lambda supports these task types through the same API Gateway endpoint:

- Customer enrichment: send a customer payload with `name`, optional hints, and `standards`.
- Standards enrichment: send `{ "task": "standards-update", "standards": [...] }`.
- Backend health check: send `{ "task": "health-check" }`.
- Shared state load: send `{ "task": "state-load" }`.
- Shared state save: send `{ "task": "state-save", "state": { ... } }`.
- Scheduled standards watch: send `{ "task": "scheduled-standards-watch", "actor": { "name": "GitHub Actions", "role": "Automation" } }`.
- Send one customer notification task: send `{ "task": "send-notification", "requestId": "req-..." }`.

Customer enrichment must return AI-backed profile data. If Claude or OpenAI is missing or failing, the Lambda now returns a clear error and does not store a customer profile.

## AWS Setup Checklist

1. Host `index.html` in the S3 static website bucket.
2. Create a Lambda function with Node.js and paste in `api/customer-enrichment/index.mjs`.
3. Set the Lambda environment variables for Claude.
4. Create a DynamoDB table for shared state and set `APP_STATE_TABLE` to that table name.
5. Create an API Gateway HTTP API route such as `POST /enrich`.
6. Connect that route to the Lambda function.
7. Copy the API Gateway invoke URL into the website Settings section.
8. Test the saved endpoint from the website.
9. Add a customer and confirm it persists after refreshing or opening the site from another browser.
10. Add `TRNA_CCB_API_URL` as a GitHub repository secret if you want the daily watch workflow to call the deployed backend.
11. Add `TEAMS_WEBHOOK_URL` and/or SES email variables in Lambda when customer notification tasks should be delivered outside the website.

## API Gateway Trigger

The repo includes `aws/api-gateway-trigger.yml`, a CloudFormation starter that creates:

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
8. Copy the API endpoint.
9. Paste the final HTTPS URL into the site's Settings field.

## Automatic AWS Deployment

This repo includes a GitHub Actions workflow at `.github/workflows/deploy-s3.yml`.

After the GitHub repository has the required secrets, every push to `main` will automatically upload the static site files to the S3 bucket.

Required GitHub repository secrets:

- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `AWS_REGION`
- `S3_BUCKET`

For the current bucket, use your active website bucket:

- `AWS_REGION`: `us-east-1`
- `S3_BUCKET`: your S3 website bucket name

The AWS user or role behind the access key needs permission to list the bucket, upload objects, delete old objects, and set object content in the S3 website bucket.

The deploy workflow excludes `.github`, `README.md`, `api`, and `aws` so backend source and infrastructure templates are not uploaded as public website files.

## Standards Change Watch

The repo includes `.github/workflows/standards-change-watch.yml`, scheduled for a daily run. It calls the deployed API Gateway endpoint with `task: scheduled-standards-watch`.

Required GitHub repository secret:

- `TRNA_CCB_API_URL`: the same API Gateway URL saved in the website Settings section.

The workflow also accepts the older `ASSURANCE_HUB_API_URL` secret as a fallback. The Lambda loads shared standards and customers from `APP_STATE_TABLE`, checks source pages, writes the updated shared state and audit event, then sends a Teams/email summary if notification environment variables are configured.
