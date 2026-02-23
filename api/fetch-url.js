import * as cheerio from 'cheerio';

export const config = {
    runtime: 'edge',
};

export default async function handler(request) {
    const { searchParams } = new URL(request.url);
    const url = searchParams.get('url');

    if (!url) {
        return new Response(JSON.stringify({ error: 'URL parameter required' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
        });
    }

    try {
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            },
        });

        const html = await response.text();
        const $ = cheerio.load(html);

        // Remove scripts, styles, and other non-content elements
        $('script, style, nav, footer, header, aside, .sidebar, .menu, .navigation').remove();

        // Extract main content
        const title = $('title').text().trim();
        const metaDescription = $('meta[name="description"]').attr('content') || '';

        // Try to find main content area
        let mainContent = '';
        const contentSelectors = ['article', 'main', '.content', '.post', '#content', '.article-body'];

        for (const selector of contentSelectors) {
            if ($(selector).length) {
                mainContent = $(selector).text().trim();
                break;
            }
        }

        // Fallback to body if no main content found
        if (!mainContent) {
            mainContent = $('body').text().trim();
        }

        // Clean up whitespace
        mainContent = mainContent.replace(/\s+/g, ' ').substring(0, 10000);

        // Extract links
        const links = [];
        $('a[href]').slice(0, 20).each((_, el) => {
            const href = $(el).attr('href');
            const text = $(el).text().trim();
            if (href && text && !href.startsWith('#')) {
                links.push({ href, text: text.substring(0, 100) });
            }
        });

        // Extract list items (often contain structured data)
        const listItems = [];
        $('li').slice(0, 30).each((_, el) => {
            const text = $(el).text().trim();
            if (text && text.length > 10 && text.length < 500) {
                listItems.push(text);
            }
        });

        // Extract table data if present
        const tables = [];
        $('table').slice(0, 3).each((_, table) => {
            const rows = [];
            $(table).find('tr').slice(0, 20).each((_, row) => {
                const cells = [];
                $(row).find('td, th').each((_, cell) => {
                    cells.push($(cell).text().trim());
                });
                if (cells.length) rows.push(cells);
            });
            if (rows.length) tables.push(rows);
        });

        return new Response(JSON.stringify({
            success: true,
            url,
            title,
            metaDescription,
            content: mainContent,
            links,
            listItems,
            tables,
        }), {
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
            },
        });

    } catch (error) {
        return new Response(JSON.stringify({
            error: 'Failed to fetch URL',
            message: error.message
        }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
        });
    }
}
