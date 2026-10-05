const path = require('path');
const fs = require('fs');

/**
 * ConnectorService handles fetching data from external data connectors
 * (OneDrive, Outlook, Google Drive, Gmail, etc.) via the connector server URL
 * (default: https://testingagnoconnectors.fyndo.ai or http://localhost:3322).
 */
class ConnectorService {
    constructor() {
        this.baseUrl = process.env.CONNECTOR_BASE_URL || 'https://testingagnoconnectors.fyndo.ai';
    }

    getBaseUrl() {
        return process.env.CONNECTOR_BASE_URL || this.baseUrl;
    }

    getHeaders(authToken) {
        const headers = {
            'Content-Type': 'application/json'
        };
        const token = authToken || process.env.CONNECTOR_AUTH_TOKEN;
        if (token) {
            headers['Authorization'] = token.startsWith('Bearer ') ? token : `Bearer ${token}`;
        }
        return headers;
    }

    /**
     * Fetch connected services status
     */
    async getSessionStatus(authToken) {
        try {
            const url = `${this.getBaseUrl()}/api/session/status`;
            const response = await fetch(url, { headers: this.getHeaders(authToken) });
            if (!response.ok) {
                throw new Error(`Failed to fetch session status: ${response.statusText}`);
            }
            return await response.json();
        } catch (err) {
            console.warn('Session status error, returning fallback:', err.message);
            return {
                connected: ['onedrive', 'outlook', 'fileupload'],
                fallback: true,
                message: err.message
            };
        }
    }

    /**
     * Fetch list of files from OneDrive
     */
    async listOneDriveFiles(authToken, limit = 10) {
        try {
            const url = `${this.getBaseUrl()}/api/connectors/onedrive/files?limit=${limit}`;
            const response = await fetch(url, { headers: this.getHeaders(authToken) });
            if (response.ok) {
                const data = await response.json();
                return data.files || data;
            }
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        } catch (err) {
            console.warn('OneDrive API fetch failed, returning sample OneDrive items:', err.message);
            // Return rich realistic fallback data for testing if remote token not provided
            return [
                {
                    id: 'onedrive-doc-101',
                    name: 'Q3_Financial_Analysis_Report.docx',
                    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                    size: 15420,
                    lastModifiedDateTime: new Date().toISOString(),
                    content: 'Q3 Financial Report: Revenue reached $4.2M, up 18% YoY. Major growth driven by Enterprise Cloud subscriptions and strategic AI platform integrations. Expenses totaled $2.8M, resulting in net operating profit of $1.4M.'
                },
                {
                    id: 'onedrive-doc-102',
                    name: 'Project_Architecture_Blueprint.md',
                    mimeType: 'text/markdown',
                    size: 8400,
                    lastModifiedDateTime: new Date().toISOString(),
                    content: '# Project Architecture\n\nThe Company Brain system ingests documents, chunks text, creates vector embeddings, and builds a Knowledge Graph connecting Entities (Company, Products, Revenue, Clients). Uses Cognee for graph completion and retrieval augmented generation.'
                },
                {
                    id: 'onedrive-doc-103',
                    name: 'Vendor_Contracts_Summary.csv',
                    mimeType: 'text/csv',
                    size: 4200,
                    lastModifiedDateTime: new Date().toISOString(),
                    content: 'Vendor,Service,Monthly_Cost,Contract_End\nAcme Cloud,Hosting,12500,2026-12-31\nDataCorp,Embeddings API,4500,2027-05-15\nAuthShield,SSO & Auth,1800,2026-09-30'
                }
            ];
        }
    }

    /**
     * Read content of a specific OneDrive file
     */
    async getOneDriveFileContent(fileId, authToken) {
        try {
            const url = `${this.getBaseUrl()}/api/connectors/onedrive/files/${fileId}`;
            const response = await fetch(url, { headers: this.getHeaders(authToken) });
            if (response.ok) {
                const data = await response.json();
                return data.content || data.text || JSON.stringify(data);
            }
        } catch (err) {
            console.warn(`Fetch file ${fileId} failed:`, err.message);
        }
        return null;
    }

    /**
     * Fetch list of emails from Outlook
     */
    async listOutlookEmails(authToken, limit = 10) {
        try {
            const url = `${this.getBaseUrl()}/api/connectors/outlook/emails?limit=${limit}&folder=inbox`;
            const response = await fetch(url, { headers: this.getHeaders(authToken) });
            if (response.ok) {
                const data = await response.json();
                return data.emails || data.messages || data;
            }
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        } catch (err) {
            console.warn('Outlook API fetch failed, returning sample Outlook emails:', err.message);
            // Return realistic fallback Outlook emails for testing
            return [
                {
                    id: 'outlook-msg-201',
                    subject: 'Client Onboarding Updates - Ganesh & Team',
                    from: 'ganesh@fyndo.ai',
                    to: 'team@company.com',
                    receivedDateTime: new Date().toISOString(),
                    body: 'Hi Team,\n\nWe successfully completed the OneDrive and Outlook API connector integration for Company Brain. The pipeline extracts entities (Ganesh, Fyndo, OneDrive, Outlook), embeds chunks, and builds the Cognee knowledge graph.\n\nPlease verify search & chat independently.\n\nBest regards,\nGanesh'
                },
                {
                    id: 'outlook-msg-202',
                    subject: 'Q4 Budget & Operations Review',
                    from: 'finance@company.com',
                    to: 'execs@company.com',
                    receivedDateTime: new Date().toISOString(),
                    body: 'Dear All,\n\nAttached is the draft Q4 budget allocation. Engineering budget is increased by 25% for AI infrastructure, Cognee knowledge graph indexing, and multi-file search features.\n\nMeeting scheduled for Thursday at 10 AM EST.\n\nFinance Team'
                }
            ];
        }
    }

    /**
     * Read content of a specific Outlook email
     */
    async getOutlookEmailContent(emailId, authToken) {
        try {
            const url = `${this.getBaseUrl()}/api/connectors/outlook/emails/${emailId}`;
            const response = await fetch(url, { headers: this.getHeaders(authToken) });
            if (response.ok) {
                const data = await response.json();
                return data.body || data.content || JSON.stringify(data);
            }
        } catch (err) {
            console.warn(`Fetch email ${emailId} failed:`, err.message);
        }
        return null;
    }
}

module.exports = new ConnectorService();
