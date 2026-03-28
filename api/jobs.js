// api/jobs.js — Vercel Serverless Function
// Fetches Job Listings + Clients from Notion and returns merged JSON

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const JOBS_DB     = 'ae3e74389f28821fa56a816073db400b';
const CLIENTS_DB  = 'b22e74389f2883a2bef781fdc9c11a5f';

const headers = () => ({
  'Authorization': `Bearer ${NOTION_TOKEN}`,
  'Notion-Version': '2022-06-28',
  'Content-Type': 'application/json'
});

async function queryDB(dbId, filter) {
  const body = { page_size: 100 };
  if (filter) body.filter = filter;
  const res = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`Notion API error ${res.status}: ${await res.text()}`);
  return res.json();
}

// Helper extractors for Notion property types
const txt   = p => p?.rich_text?.[0]?.plain_text  || '';
const ttl   = p => p?.title?.[0]?.plain_text       || '';
const sel   = p => p?.select?.name                 || '';
const url   = p => p?.url                          || null;

module.exports = async function handler(req, res) {
  // CORS + cache (5 min CDN, 10 min stale-while-revalidate)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');

  if (!NOTION_TOKEN) {
    return res.status(500).json({ error: 'NOTION_TOKEN environment variable is not set.' });
  }

  try {
    // Fetch active jobs and active clients in parallel
    const [jobsData, clientsData] = await Promise.all([
      queryDB(JOBS_DB,    { property: 'Status', select: { equals: 'Active' } }),
      queryDB(CLIENTS_DB, { property: 'Status', select: { equals: 'Active' } })
    ]);

    // Build clients lookup map: Notion page ID → structured client object
    const clientsMap = {};
    for (const page of (clientsData.results || [])) {
      const p = page.properties;
      const cultureTags = txt(p['Culture Tags'])
        .split(',')
        .map(t => t.trim())
        .filter(Boolean);

      clientsMap[page.id] = {
        name:            ttl(p['Company Name']),
        logoUrl:         url(p['Logo URL']),
        websiteUrl:      url(p['Website URL']),
        linkedInUrl:     url(p['LinkedIn URL']),
        instagramUrl:    url(p['Instagram URL']),
        shortDescription: txt(p['Short Description']),
        about:           txt(p['About The Client (Full)']),
        benefits:        txt(p['Benefits']),
        whyWorkHere:     txt(p['Why Work Here']),
        industry:        sel(p['Industry']),
        companySize:     sel(p['Company Size']),
        headquarters:    txt(p['Headquarters']),
        cultureTags
      };
    }

    // Build jobs array — merge job fields with related client data
    const jobs = (jobsData.results || []).map(page => {
      const p = page.properties;

      // Follow the Client relation to get the linked client
      const clientId = p['Client']?.relation?.[0]?.id;
      const client   = clientId ? clientsMap[clientId] : null;

      // Parse key requirements: split text block by newline or ", " patterns
      const reqRaw = txt(p['Key Requirements']);
      const keyRequirements = reqRaw
        .split(/\n|(?<=\w),\s+/)
        .map(r => r.trim())
        .filter(Boolean);

      return {
        id:               page.id,
        title:            ttl(p['Job Title']),
        company:          client?.name           || sel(p['Client Company']),
        companyLogo:      client?.logoUrl        || '',
        companyWebsite:   client?.websiteUrl     || '',
        companyLinkedIn:  client?.linkedInUrl    || '',
        companyInstagram: client?.instagramUrl   || null,
        companyIndustry:  client?.industry       || '',
        companyHQ:        client?.headquarters   || '',
        companyAbout:     client?.about          || '',
        companyWhyWorkHere: client?.whyWorkHere  || '',
        companyBenefits:  client?.benefits       || '',
        companyCultureTags: client?.cultureTags  || [],
        category:         sel(p['Category']),
        seniority:        sel(p['Seniority']),
        employmentType:   sel(p['Employment Type']),
        salaryRange:      txt(p['LATAM Salary Range']),
        location:         txt(p['Location']),
        shortDescription: txt(p['Short Description']),
        keyRequirements,
        postedDate:       p['Posted Date']?.date?.start || ''
      };
    });

    return res.status(200).json({ jobs, total: jobs.length });

  } catch (err) {
    console.error('[api/jobs] Error:', err);
    return res.status(500).json({ error: 'Failed to fetch from Notion', detail: err.message });
  }
};
