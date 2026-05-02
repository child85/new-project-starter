# new-project-starter

Initial repository for the new project.

## Current demo

This project contains a single-page static website in `index.html`. The page is designed to be uploaded directly to an Amazon S3 bucket and served with S3 Static Website Hosting.

The page now includes a customer lookup and enrichment workflow:

- resolve a customer name and confirm ambiguous entities
- enrich customer metadata such as website, headquarters, sector, size, markets, and summary
- infer likely standards and compliance exposure
- save customers into a browser-based demo list
- keep hypercare customers attached to standards for future change notifications
- generate top engagement, cross-sell, and upsell ideas

## Architecture

The current website architecture is:

```text
Visitor's browser
      |
      v
S3 static website endpoint
      |
      v
index.html
```

S3 is acting as the web host. It stores the HTML file and returns it directly to visitors when they open the bucket website endpoint.

The live page works today with browser demo enrichment. That means it is useful for demos, but saved data stays in the user's browser until the backend is connected.

## Production app architecture

For real AI enrichment, do not put an AI key in the static page. Use this architecture:

```text
Visitor's browser
      |
      v
S3 static website
      |
      v
API Gateway
      |
      v
Lambda function
      |
      v
AI model + DynamoDB
```

In that setup:

- S3 hosts the public website.
- API Gateway provides an HTTPS endpoint for the page to call.
- Lambda runs the customer enrichment logic and calls the AI model from the server side.
- DynamoDB stores customer profiles, enrichment runs, standards links, and hypercare records.
- EventBridge can run a daily standards/regulations change check.

This keeps secrets out of the browser and gives the team a proper shared database.

## Customer enrichment backend

A starter Lambda lives in `api/customer-enrichment/`.

Environment variables:

- `OPENAI_API_KEY`: optional. If omitted, the Lambda returns deterministic demo enrichment.
- `OPENAI_MODEL`: optional model override.
- `CUSTOMER_TABLE`: optional DynamoDB table name for saving enrichment results.
- `ALLOWED_ORIGIN`: optional CORS origin for the deployed site.

After the Lambda is deployed behind API Gateway, paste the API endpoint into the "AI Backend Setup" section of the page. The browser will try the AWS backend first and fall back to demo enrichment if the endpoint is unavailable.

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

The deploy workflow excludes `.github`, `README.md`, and `api` so backend source files are not uploaded as public website files.

## Standards change watch

The repo also includes `.github/workflows/standards-change-watch.yml`, scheduled for a daily run. It is currently a scaffold: the next production step is to connect official standards/regulatory sources, compare detected changes against the standards linked to hypercare customers, and notify the responsible account owner.

The current static page stores prototype additions in the browser with local storage. A production version should move standards, customers, hypercare links, enrichment audit runs, and notifications into DynamoDB or another backend database.
