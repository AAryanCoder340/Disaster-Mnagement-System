# CoastWatch external source notes (no invented endpoints)

## IMD — India Meteorological Department
- Portal: https://api.imd.gov.in/
- Field reference: https://api.imd.gov.in/public/api_reference.html
- Contact for terms/access: Dr. Sankar Nath, Sc-E, IMD New Delhi (sankar.nath@imd.gov.in) per IMD API notice
- Auth: Secure JWT / key-based access after account creation. Unauthenticated calls to documented `/api/v1/*` URLs returned HTTP 401 from this project environment.
- Rate limits: not documented on the public reference page reviewed.
- IP whitelisting: not documented on the public reference page; the portal describes authenticated onboarding.
- Free vs paid: not stated as a public free anonymous API.
- Endpoints used by CoastWatch when credentials exist:
  - https://api.imd.gov.in/api/v1/districtwarning
  - https://api.imd.gov.in/api/v1/districtnowcast
  - https://api.imd.gov.in/api/v1/districtrainfall
  - https://api.imd.gov.in/api/v1/current_wx
  - https://api.imd.gov.in/api/v1/portwarning
- Env: IMD_API_TOKEN or IMD_JWT (Bearer), optional IMD_API_KEY

## NDMA SACHET
- Public portal: https://sachet.ndma.gov.in/
- RSS landing page (HTML, not a live XML feed): https://sachet.ndma.gov.in/CapFeed
- CAP XML per identifier: https://sachet.ndma.gov.in/cap_public_website/FetchXMLFile?identifier=...
- Agency integration guide (ETag/304): https://sachet.ndma.gov.in/docs/Integration_Guide_For_Agencies.pdf
- Auth for RSS: public website describes RSS for agencies; a stable RSS XML URL was not published as a single documented path on CapFeed HTML.
- Env: SACHET_RSS_URL must be the actual RSS/Atom XML URL if/when provided by NDMA.

## backend/data
Holds the SQLite file `coastwatch.db`. It is not a folder of fake JSON disaster feeds. Demo rows are labelled DEMO_SEED in the database.
