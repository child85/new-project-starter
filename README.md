# new-project-starter

Initial repository for the new project.

## Current demo

This project contains a single-page static website in `index.html`. The page is designed to be uploaded directly to an Amazon S3 bucket and served with S3 Static Website Hosting.

## Architecture

The current architecture is:

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

For a simple public demo page, this is enough. There is no server and no database yet.

## Future app architecture

If the site needs to save data, such as contact form submissions or user records, the next version would usually look like this:

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
DynamoDB
```

In that setup:

- S3 hosts the public website.
- API Gateway provides an HTTPS endpoint for the page to call.
- Lambda runs backend code only when needed.
- DynamoDB stores application data without managing a database server.

This keeps the demo inexpensive, scalable, and simple to maintain while leaving room to grow into a real web app.

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

## Standards change watch

The repo also includes `.github/workflows/standards-change-watch.yml`, scheduled for a daily run. It is currently a scaffold: the next production step is to connect official standards/regulatory sources, compare detected changes against the standards linked to hypercare customers, and notify the responsible account owner.

The current static page stores prototype additions in the browser with local storage. A production version should move standards, customers, hypercare links, and notifications into a backend database.
