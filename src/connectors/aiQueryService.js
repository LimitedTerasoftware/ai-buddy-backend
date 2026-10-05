const dbConnectorService = require('./dbConnectorService');

class AIQueryService {
    getWestBengalTicketRelationships() {
        return `WEST BENGAL TICKET DOMAIN RELATIONSHIPS (mandatory when the request is about tickets):
- master_tickets.ticketid = user_requests.booking_id. Always JOIN these tables for ticket questions that need request status, category, close mode, or ticket/request details.
- user_requests.status is the authoritative request status and uses: SEARCHING, CANCELLED, ACCEPTED, STARTED, ARRIVED, PICKEDUP, DROPPED, COMPLETED, SCHEDULED, ONCALL, REACHED, REASSIGNED, INCOMING, ONHOLD.
- Business status mapping from the Laravel AdminController:
  * "ongoing", "running", "in progress", "picked up", "pickup" => user_requests.status = 'PICKEDUP'
  * "not started", "notstarted", "pending", "open", "new" => user_requests.status = 'INCOMING'
  * "hold", "on hold", "onhold" => user_requests.status = 'ONHOLD'
  * "completed", "closed", "resolved" => user_requests.status = 'COMPLETED'
  * "scheduled" => user_requests.status = 'SCHEDULED'
  Never use non-database status literals such as 'ONGOING', 'NOTSTARTED', 'NOT_STARTED', 'PENDING', 'HOLD', or 'CLOSED' in SQL predicates.
- user_requests.autoclose is the authoritative close mode and uses: Regular, Manual, Auto. Use it to separate auto-close and manual-close tickets.
- Ticket category is user_requests.category when populated; user_requests.downreason may contain the category/reason label and should be used as a fallback with COALESCE(NULLIF(user_requests.category, ''), user_requests.downreason).
- Controller category/downreason mapping:
  * power/UPS => user_requests.downreason LIKE '%Power%'
  * electronics/ONT/software/hardware => user_requests.downreason REGEXP 'ONT|Software/Hardware'
  * solar/SPV/SLA => user_requests.downreason REGEXP 'SOLAR|SPV|SLA'
  * fiber => user_requests.downreason REGEXP 'FIBER'
  * CCU/battery => user_requests.downreason REGEXP 'CCU|Battery'
  * OLT => user_requests.downreason REGEXP 'OLT'
  * other/no bin/gp shifting/pp extension => user_requests.downreason REGEXP 'Others|No Bin Type|GP Shifting|PP Extension|Other'
- Date semantics from the controller:
  * assigned/generated/opened/ticket created counts use user_requests.created_at
  * completed/closed counts use user_requests.finished_at
  * ongoing/PICKEDUP and onhold counts use user_requests.started_at when the user asks for today/yesterday/time-window status activity
  * dashboard totals without a date filter count all matching user_requests rows
- Use user_requests.state_id to join states.state_id, and user_requests.district_id to join districts.id. Use master_tickets.district, master_tickets.mandal, and master_tickets.gpname for the ticket's text location when those fields are requested. Preserve the ticket join while adding these location joins/fields.
- For team questions, use user_requests.provider_id = providers.id and providers.team_id = teams.id when those columns/tables are available.
- Attendance/staff tracking relationships from StaffTrack:
  * attendance.provider_id = providers.id. One provider can have many attendance rows.
  * Workforce designations are numeric IDs stored in providers.type; they do not have separate attendance tables. Mandatory mapping: 2 = FRT, 3 = Zonal Incharge, 4 = District Incharge, 5 = Patroller (also understand the user spelling Patroler), 6 = MIS, 8 = Block Engineer, 9 = Construction Engineer. Filter with these numeric IDs, never with designation text. When displaying or grouping roles, translate providers.type with a CASE expression to a designation alias.
  * Workforce scope uses providers.company_id and providers.state_id, optionally providers.district_id, providers.block_id, or providers.zone_id, and includes only providers.status = 'approved'. Apply company/state IDs when supplied by the user or application context; do not invent their values.
  * providers.district_id = districts.id and providers.zone_id = zonal_managers.id. Use districts.name as district_name and zonal_managers.Name as zone_name.
  * attendance.created_at is check-in and its DATE is the attendance/work date; attendance.updated_at is treated as check-out; attendance.status is the online status; attendance.online_image is the check-in image.
  * attendance.start_time and attendance.end_time are used by dashboard duration calculations. Late attendance in the detailed list is check-in after 09:30:00; prefer attendance.created_at for this definition, while preserving start_time/end_time when the user explicitly asks for shift duration.
  * leaves.provider_id = providers.id. A provider is on leave when leaves.status = 'approved' and the requested attendance date/range overlaps leaves.start_date through leaves.end_date.
  * Present = a distinct approved provider with an attendance row in the requested period and no overlapping approved leave. Absent = total approved staff minus present; in detailed filtering, no attendance or an overlapping approved leave is absent. Late = present with TIME(attendance.created_at) > '09:30:00'.
  * provider_tracking_histories.provider_id = providers.id. Match tracking to attendance by the same provider_id and DATE(provider_tracking_histories.created_at) = DATE(attendance.created_at); there is no attendance_id relationship in the controller.
  * provider_tracking_histories.latlng is JSON containing points with latitude, longitude, and datetime. Order all decoded points by datetime before calculating travelled distance. Do not invent a stored distance column; distance is calculated in application code with DistanceHelper.calculateAccurateDistance.
  * user_requests.provider_id = providers.id. For an attendance day's assigned ticket count, match DATE(user_requests.created_at) = DATE(attendance.created_at); completed tickets additionally require user_requests.status = 'COMPLETED'.
  * submitfiles.provider_id = providers.id and submitfiles.request_id = user_requests.id. Use these keys for ticket image/file questions.
  * When a specific date is supplied, filter every daily attendance, tracking, and ticket dataset to that same date. Without a date, attendance history is ordered by attendance.created_at DESC; today's provider image join filters DATE(attendance.created_at) = CURRENT_DATE.
- Do not use master_tickets.status for request-status questions unless the user explicitly asks for the legacy numeric master-ticket status. Do not invent a team or attendance relationship when no matching key exists.`;
    }

    repairTicketDomainSQL(sql) {
        if (!sql) return sql;

        const statusLiteralMap = {
            ONGOING: 'PICKEDUP',
            'ON GOING': 'PICKEDUP',
            RUNNING: 'PICKEDUP',
            INPROGRESS: 'PICKEDUP',
            'IN PROGRESS': 'PICKEDUP',
            NOTSTARTED: 'INCOMING',
            'NOT STARTED': 'INCOMING',
            NOT_STARTED: 'INCOMING',
            PENDING: 'INCOMING',
            OPEN: 'INCOMING',
            HOLD: 'ONHOLD',
            'ON HOLD': 'ONHOLD',
            CLOSED: 'COMPLETED',
            RESOLVED: 'COMPLETED'
        };

        return sql.replace(/(['"])(ONGOING|ON GOING|RUNNING|INPROGRESS|IN PROGRESS|NOTSTARTED|NOT STARTED|NOT_STARTED|PENDING|OPEN|HOLD|ON HOLD|CLOSED|RESOLVED)\1/gi, (match, quote, literal) => {
            const normalized = literal.toUpperCase();
            return `${quote}${statusLiteralMap[normalized] || literal}${quote}`;
        });
    }

    /**
     * Call OpenAI API to generate or summarize content
     */
    async callLLM(prompt, systemInstruction = 'You are an expert SQL and Database AI Assistant.') {
        const apiKey = process.env.OPENAI_API_KEY || process.env.LLM_API_KEY;
        const model = process.env.LLM_MODEL || 'gpt-4o-mini';

        if (!apiKey) {
            throw new Error('OPENAI_API_KEY not configured');
        }

        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model,
                messages: [
                    { role: 'system', content: systemInstruction },
                    { role: 'user', content: prompt }
                ],
                temperature: 0.1,
                max_tokens: 1000
            })
        });

        if (!response.ok) {
            const errData = await response.json().catch(() => ({}));
            throw new Error(`OpenAI API error (${response.status}): ${errData.error?.message || response.statusText}`);
        }

        const data = await response.json();
        return data.choices[0]?.message?.content?.trim() || '';
    }

    /**
     * Heuristic fallback SQL generator if LLM is unavailable
     */
    generateFallbackSQL(query, dbType = 'mysql') {
        const qLower = query.toLowerCase();
        const isYesterday = qLower.includes('yesterday') || qLower.includes('last day');
        const isToday = qLower.includes('today');

        // Dashboard-style ticket category breakdowns.
        if ((qLower.includes('dashboard') || qLower.includes('category')) && qLower.includes('ticket')) {
            if (dbType === 'postgres') {
                return `SELECT COALESCE(NULLIF(ur.category, ''), NULLIF(ur.downreason, ''), 'uncategorized') AS category, COUNT(*)::int AS total, SUM(CASE WHEN ur.status = 'COMPLETED' THEN 1 ELSE 0 END)::int AS completed, SUM(CASE WHEN ur.status = 'PICKEDUP' THEN 1 ELSE 0 END)::int AS ongoing, SUM(CASE WHEN ur.status = 'ONHOLD' THEN 1 ELSE 0 END)::int AS onhold, SUM(CASE WHEN ur.status = 'INCOMING' THEN 1 ELSE 0 END)::int AS not_started FROM user_requests ur INNER JOIN master_tickets mt ON mt.ticketid = ur.booking_id GROUP BY COALESCE(NULLIF(ur.category, ''), NULLIF(ur.downreason, ''), 'uncategorized') ORDER BY total DESC LIMIT 50;`;
            }
            return `SELECT COALESCE(NULLIF(ur.category, ''), NULLIF(ur.downreason, ''), 'uncategorized') AS category, COUNT(*) AS total, SUM(ur.status = 'COMPLETED') AS completed, SUM(ur.status = 'PICKEDUP') AS ongoing, SUM(ur.status = 'ONHOLD') AS onhold, SUM(ur.status = 'INCOMING') AS not_started FROM user_requests ur INNER JOIN master_tickets mt ON mt.ticketid = ur.booking_id GROUP BY COALESCE(NULLIF(ur.category, ''), NULLIF(ur.downreason, ''), 'uncategorized') ORDER BY total DESC LIMIT 50;`;
        }

        // Ticket queries (master_tickets / user_requests)
        if (qLower.includes('ticket')) {
            const joinedTicketSummary = `SELECT ur.status, ur.autoclose, COUNT(*) AS count FROM user_requests ur INNER JOIN master_tickets mt ON mt.ticketid = ur.booking_id GROUP BY ur.status, ur.autoclose ORDER BY ur.status, ur.autoclose;`;
            if (isYesterday) {
                return dbType === 'postgres'
                    ? `SELECT ur.status, ur.autoclose, COUNT(*)::int AS count FROM user_requests ur INNER JOIN master_tickets mt ON mt.ticketid = ur.booking_id WHERE CAST(COALESCE(ur.created_at, mt.created_at) AS DATE) = CURRENT_DATE - INTERVAL '1 day' GROUP BY ur.status, ur.autoclose ORDER BY ur.status, ur.autoclose;`
                    : `SELECT ur.status, ur.autoclose, COUNT(*) AS count FROM user_requests ur INNER JOIN master_tickets mt ON mt.ticketid = ur.booking_id WHERE DATE(COALESCE(ur.created_at, mt.created_at)) = CURDATE() - INTERVAL 1 DAY GROUP BY ur.status, ur.autoclose ORDER BY ur.status, ur.autoclose;`;
            } else if (isToday) {
                return dbType === 'postgres'
                    ? `SELECT ur.status, ur.autoclose, COUNT(*)::int AS count FROM user_requests ur INNER JOIN master_tickets mt ON mt.ticketid = ur.booking_id WHERE CAST(COALESCE(ur.created_at, mt.created_at) AS DATE) = CURRENT_DATE GROUP BY ur.status, ur.autoclose ORDER BY ur.status, ur.autoclose;`
                    : `SELECT ur.status, ur.autoclose, COUNT(*) AS count FROM user_requests ur INNER JOIN master_tickets mt ON mt.ticketid = ur.booking_id WHERE DATE(COALESCE(ur.created_at, mt.created_at)) = CURDATE() GROUP BY ur.status, ur.autoclose ORDER BY ur.status, ur.autoclose;`;
            } else {
                return joinedTicketSummary;
            }
        }

        // Attendance/workforce queries, including all numeric provider designations.
        const requestedDesignationIds = [
            { id: 2, requested: qLower.includes('frt') },
            { id: 3, requested: qLower.includes('zonal incharge') || qLower.includes('zone incharge') },
            { id: 4, requested: qLower.includes('district incharge') },
            { id: 5, requested: qLower.includes('patroller') || qLower.includes('patroler') },
            { id: 6, requested: /\bmis\b/.test(qLower) },
            { id: 8, requested: qLower.includes('block engineer') },
            { id: 9, requested: qLower.includes('construction engineer') }
        ].filter(role => role.requested).map(role => role.id);
        if (qLower.includes('attendance') || qLower.includes('workforce') || requestedDesignationIds.length > 0) {
            const roleFilter = requestedDesignationIds.length > 0
                ? ` AND p.type IN (${requestedDesignationIds.join(', ')})`
                : '';
            const designationCase = `CASE p.type WHEN 2 THEN 'FRT' WHEN 3 THEN 'Zonal Incharge' WHEN 4 THEN 'District Incharge' WHEN 5 THEN 'Patroller' WHEN 6 THEN 'MIS' WHEN 8 THEN 'Block Engineer' WHEN 9 THEN 'Construction Engineer' ELSE CONCAT('Type ', p.type) END`;

            if (dbType === 'postgres') {
                const targetDate = isYesterday ? `CURRENT_DATE - INTERVAL '1 day'` : 'CURRENT_DATE';
                const postgresDesignationCase = designationCase.replace("CONCAT('Type ', p.type)", "'Type ' || p.type::text");
                return `SELECT p.type AS role_id, ${postgresDesignationCase} AS designation, COUNT(DISTINCT p.id)::int AS total_staff, COUNT(DISTINCT CASE WHEN a.provider_id IS NOT NULL AND l.id IS NULL THEN p.id END)::int AS present, (COUNT(DISTINCT p.id) - COUNT(DISTINCT CASE WHEN a.provider_id IS NOT NULL AND l.id IS NULL THEN p.id END))::int AS absent, COUNT(DISTINCT CASE WHEN a.provider_id IS NOT NULL AND l.id IS NULL AND CAST(a.created_at AS TIME) > TIME '09:30:00' THEN p.id END)::int AS late FROM providers p LEFT JOIN attendance a ON a.provider_id = p.id AND CAST(a.created_at AS DATE) = ${targetDate} LEFT JOIN leaves l ON l.provider_id = p.id AND l.status = 'approved' AND ${targetDate} BETWEEN l.start_date AND l.end_date WHERE p.status = 'approved'${roleFilter} GROUP BY p.type ORDER BY p.type LIMIT 50;`;
            }

            const targetDate = isYesterday ? 'DATE_SUB(CURDATE(), INTERVAL 1 DAY)' : 'CURDATE()';
            return `SELECT p.type AS role_id, ${designationCase} AS designation, COUNT(DISTINCT p.id) AS total_staff, COUNT(DISTINCT CASE WHEN a.provider_id IS NOT NULL AND l.id IS NULL THEN p.id END) AS present, COUNT(DISTINCT p.id) - COUNT(DISTINCT CASE WHEN a.provider_id IS NOT NULL AND l.id IS NULL THEN p.id END) AS absent, COUNT(DISTINCT CASE WHEN a.provider_id IS NOT NULL AND l.id IS NULL AND TIME(a.created_at) > '09:30:00' THEN p.id END) AS late FROM providers p LEFT JOIN attendance a ON a.provider_id = p.id AND DATE(a.created_at) = ${targetDate} LEFT JOIN leaves l ON l.provider_id = p.id AND l.status = 'approved' AND ${targetDate} BETWEEN l.start_date AND l.end_date WHERE p.status = 'approved'${roleFilter} GROUP BY p.type ORDER BY p.type LIMIT 50;`;
        }

        // Providers query
        if (qLower.includes('provider') || qLower.includes('technician') || qLower.includes('engineer')) {
            return `SELECT status, COUNT(*) as count FROM providers GROUP BY status;`;
        }

        // Stock Balance query
        if (qLower.includes('stock') || qLower.includes('material')) {
            return `SELECT m.name AS material_name, m.code, SUM(sb.quantity) as total_quantity FROM stock_balance sb JOIN materials m ON sb.material_id = m.id GROUP BY m.id, m.name, m.code ORDER BY total_quantity DESC LIMIT 15;`;
        }

        // User requests query
        if (qLower.includes('request') || qLower.includes('booking')) {
            return `SELECT status, COUNT(*) as count FROM user_requests GROUP BY status;`;
        }

        return null;
    }

    /**
     * Generate SQL from natural language query using database schema and LLM
     */
    async generateSQLFromNL(userQuery, connConfig) {
        const dbType = (connConfig.db_type || 'mysql').toLowerCase();
        const tables = await dbConnectorService.listTables(connConfig);

        // Compress schema definitions into a concise prompt format
        const schemaSummary = tables.map(t => {
            const colList = t.columns.map(c => `${c.name} (${c.type})`).join(', ');
            const relationshipList = (t.relationships || []).map(relation =>
                `${t.tableName}.${relation.column} -> ${relation.targetTable}.${relation.targetColumn}`
            ).join('; ');
            return `Table: \`${t.tableName}\` (${t.rowCount} rows) -> Columns: [${colList}]${relationshipList ? ` -> Relationships: [${relationshipList}]` : ''}`;
        }).join('\n');

        const prompt = `You are an expert SQL query generator for a ${dbType.toUpperCase()} database.
Given the following database schema:
${schemaSummary}

    ${this.getWestBengalTicketRelationships()}

User Request: "${userQuery}"

Rules:
1. Return ONLY the raw executable ${dbType.toUpperCase()} SQL SELECT query.
2. DO NOT wrap the query in markdown backticks or explanations.
3. Use appropriate date functions for ${dbType.toUpperCase()}:
   - For MySQL: CURDATE(), NOW(), DATE_SUB(CURDATE(), INTERVAL 1 DAY), DATE(column) = CURDATE() - INTERVAL 1 DAY
   - For PostgreSQL: CURRENT_DATE, NOW(), CURRENT_DATE - INTERVAL '1 day', CAST(column AS DATE)
4. For ticket questions, follow the mandatory ticket-domain relationships above and include INNER JOIN master_tickets mt ON mt.ticketid = ur.booking_id whenever user_requests and master_tickets are both relevant.
5. For master_tickets legacy status questions only: 0 = PENDING / OPEN, 1 = COMPLETED / RESOLVED, 2 = ONHOLD / IN_PROGRESS.
6. For dashboard questions, return aggregate columns with clear aliases such as total, completed, ongoing, onhold, not_started, today_completed, and yesterday_completed. Use SUM(ur.status = 'PICKEDUP') AS ongoing, not ur.status = 'ONGOING'.
7. For ticket category questions, use COALESCE(NULLIF(ur.category, ''), ur.downreason) and group by that expression. Keep the ticket join.
8. For auto/manual close questions, group or filter by ur.autoclose. For location questions, join states and districts using ur.state_id and ur.district_id and use mt.mandal and mt.gpname when requested.
9. Use the listed relationship mappings when a question asks how tables or records are related.
10. For attendance/staff tracking questions, use attendance.provider_id = providers.id and correlate attendance, provider_tracking_histories, and user_requests by provider plus calendar date. Use submitfiles.request_id = user_requests.id for ticket images. Never assume tracking has an attendance_id or a stored total_distance column.
11. If distance is requested, return the provider/date and provider_tracking_histories.latlng JSON needed by the application to calculate it; SQL must not claim to reproduce DistanceHelper unless the database schema explicitly provides an equivalent function.
12. For any workforce designation, filter providers.type with its numeric designation ID from the attendance-domain mapping, keep providers.status = 'approved', count distinct providers, and exclude overlapping approved leave from present. Return a readable designation using CASE. Default attendance period is today unless another date/range is requested.
13. Limit results to max 50 rows if returning raw records.
14. Return only a valid read-only SELECT statement.`;

        try {
            let sql = await this.callLLM(prompt, 'You are an accurate SQL compiler that outputs only valid single SQL queries without markdown formatting.');
            // Clean up any potential markdown fences
            sql = sql.replace(/```sql/gi, '').replace(/```/g, '').trim();
            sql = this.repairTicketDomainSQL(sql);
            if (sql.toUpperCase().startsWith('SELECT') || sql.toUpperCase().startsWith('WITH')) {
                return sql;
            }
        } catch (err) {
            console.warn('[AIQueryService] LLM SQL generation error (falling back):', err.message);
        }

        // Heuristic fallback
        const fallback = this.generateFallbackSQL(userQuery, dbType);
        if (fallback) return this.repairTicketDomainSQL(fallback);

        throw new Error('Unable to generate SQL query for request');
    }

    /**
     * Process natural language query: Generate SQL, execute it, and format AI answer
     */
    async processNLQuery(connConfig, userQuery) {
        const sql = await this.generateSQLFromNL(userQuery, connConfig);
        console.log(`[AIQueryService] Executing SQL against ${connConfig.name}:`, sql);

        const execResult = await dbConnectorService.executeRawQuery(connConfig, sql, 100);
        const rows = execResult.rows || [];
        const columns = execResult.columns || [];

        // Build Markdown Table
        let tableMarkdown = '';
        if (rows.length > 0) {
            const displayCols = columns.slice(0, 10);
            const headerRow = `| ${displayCols.join(' | ')} |`;
            const dividerRow = `| ${displayCols.map(() => '---').join(' | ')} |`;
            const dataRows = rows.map(r => {
                const cells = displayCols.map(c => {
                    const val = r[c];
                    if (val === null || val === undefined) return '*NULL*';
                    if (typeof val === 'object') return JSON.stringify(val);
                    return String(val);
                });
                return `| ${cells.join(' | ')} |`;
            }).join('\n');

            tableMarkdown = `${headerRow}\n${dividerRow}\n${dataRows}`;
        }

        // Ask LLM to generate a natural, professional summary of the query results
        let aiSummary = '';
        try {
            const summaryPrompt = `User Question: "${userQuery}"
Executed SQL: ${sql}
SQL Results (${rows.length} rows returned):
${JSON.stringify(rows.slice(0, 15), null, 2)}

Provide a concise, direct, and well-structured answer explaining the numbers and status counts clearly. Mention key figures upfront.`;
            
            aiSummary = await this.callLLM(summaryPrompt, 'You are a helpful telecom database assistant. Give clear, informative answers with markdown formatting.');
        } catch (e) {
            // Heuristic formatting if LLM summary fails
            if (rows.length > 0 && rows[0].count !== undefined) {
                const breakdown = rows.map(r => `• **${r.status_name || r.status || 'Status'}**: ${r.count || r.total || 0}`).join('\n');
                aiSummary = `Here is the requested breakdown based on live database records:\n\n${breakdown}`;
            } else {
                aiSummary = `Retrieved **${rows.length} record(s)** from database \`${connConfig.name}\`.`;
            }
        }

        const fullAnswer = `### 📊 Query Analysis & Database Answer\n\n${aiSummary}\n\n` +
            (tableMarkdown ? `#### 📋 Data Results:\n${tableMarkdown}\n\n` : '') +
            `> **Executed SQL Query:**\n\`\`\`sql\n${sql}\n\`\`\`\n` +
            `*(Executed on ${connConfig.name} in ${execResult.executionTimeMs}ms)*`;

        return {
            answer: fullAnswer,
            tableData: rows.length > 0 ? {
                tableName: 'AI Query Result',
                dbSource: connConfig.name,
                dbType: connConfig.db_type,
                columns: columns.slice(0, 10),
                rows: rows,
                totalRows: rows.length
            } : null,
            sources: [{
                title: `Database: ${connConfig.name} (${connConfig.db_type.toUpperCase()})`,
                sourceType: 'DATABASE',
                relevance: '1.0'
            }],
            sqlQuery: sql
        };
    }
}

module.exports = new AIQueryService();
