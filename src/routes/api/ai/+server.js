//@ts-check

import { json } from '@sveltejs/kit';
import OpenAI from 'openai';
import { OPENAI_API_KEY, GITHUB_TOKEN } from '$lib/server/config';
import { zodResponseFormat } from 'openai/helpers/zod';
import { z } from 'zod';
import axios from 'axios';

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

const DPGStatus = z.object({
  recommendation: z.string(),
  overallScore: z.number(),
  explanation: z.string(),
});

/** @type {import('./$types').RequestHandler} */
export async function POST({ request }) {
  const { url } = await request.json();

  console.log('Evaluating:', url);

  const { owner, repo } = parseGithubUrl(url);
  if (!owner || !repo) {
    return json({ success: false, message: 'Invalid GitHub repository URL' });
  }

  const repoData = await getAllRelevantFiles(owner, repo); // Fetch GitHub data

  if (!repoData) {
    return json({
      success: false,
      message: 'Unable to access the GitHub repository or retrieve files',
    });
  }

  console.log('Repo Data:', repoData);

  const messages = getDPGStatusPrompt(url, repoData);
  const response = await fetchAIResponse(messages);

  console.log('OPEN AI:', response.choices[0].message.parsed);
  const parsedResponse = response.choices[0].message.parsed;

  return json({ success: true, parsedResponse });
}

/**
 * @param {any} messages
 */
async function fetchAIResponse(messages) {
  return await openai.beta.chat.completions.parse({
    model: 'gpt-4o',
    messages,
    response_format: zodResponseFormat(DPGStatus, 'DPGStatus'),
    temperature: 0,
  });
}

/**
 * Generates the prompt for DPG status evaluation
 * @param {string} githubUrl - URL of the GitHub repository
 * @param {any} repoData - Repository data
 * @returns {any[]} Array of message objects for the AI
 */
function getDPGStatusPrompt(githubUrl, repoData) {
  return [
    {
      role: 'system',
      content:
        'You are an expert in evaluating open-source software and can determine if a GitHub repository meets the criteria for a DPG.',
    },
    {
      role: 'user',
      content: `Evaluate the following GitHub repository based on the DPG criteria.

      GitHub repository: ${githubUrl}

      Repository Data: ${JSON.stringify(repoData)}

      DPG Criteria:
1. the digital solution is relevant to one of the Sustainable Development Goals
A digital solution as a whole, or its subcomponents must contribute to the attainment of the Sustainable Development Goals. For example, a digital solution with a goal, mission or vision relevant to an SDG, or a digital solution that produces a data set relevant to an SDG would qualify. In either case, there must be clear intentions to further the SDG in question through your work.

2. it uses an approved open-source license
For this indicator, you must provide a public link that explicitly mentions an approved open license for your digital solution. Licenses for Open Software, Open Content, and Open Data are vetted and approved by third-party organizations, and we rely on their criteria in order to include them in our list of acceptable licenses. On top of that, we use SPDX identifiers to easily, efficiently, and uniquely refer to each license.

3. Clear ownership
For this indicator, the ownership (individual or an organisation) of the project and everything the project produces must be clearly defined and publicly documented so that there are no inconsistencies/misrepresentations. Ownership is important because it defines accountability.

4. platform independence
Your digital solution must disclose its mandatory dependencies or assets (i.e. libraries, software, or hardware) which may create more restrictions than the original license. Applicants must provide a description of how open-source components are independent and/or list the open alternatives for any closed component(s).

5. Documentation
Documentation could include an open repository, technical specifications, functional requirements, etc., that would allow a technical person unfamiliar with the project to launch and run the software.

6. Mechanism for Extracting Data
Provide a detailed description of how NON-PII data can be imported or exported into non-proprietary formats such as CSV, XML, JSON, etc., or by exposing the NON-PII data through an API.

7. Privacy & Applicable Laws
Provide a link to the privacy policy, terms of service, or other relevant legal documentation of your digital solution.

8. Open Standards & Best Practices
Provide a list of the open standards, best practices, and principles that your digital solution adheres to with relevant links.

9. Do No Harm by Design
Provide evidence on how your digital solution was designed to take into consideration the use of PII data, usage by underage users, illegal content, enforcing code of conduct, etc.

Provide a score of 0 or 1 for each criterion and a detailed explanation of what the project is missing.`,
    },
  ];
}

// Function to interact with GitHub API and fetch file contents
/**
 * Retrieves the content of a file from a GitHub repository
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @param {string} filePath - Path to the file
 * @returns {Promise<string|null>} File content or null if not found
 */
async function getFileContent(owner, repo, filePath) {
  try {
    const headers = GITHUB_TOKEN ? { Authorization: `token ${GITHUB_TOKEN}` } : {};
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`;
    const response = await axios.get(apiUrl, { headers });
    return Buffer.from(response.data.content, 'base64').toString('utf-8');
  } catch (error) {
    return null;
  }
}

// Function to interact with GitHub API and retrieve all markdown (.md) files
/**
 * Retrieves all markdown files from a GitHub repository
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @param {string} [path=''] - Path within the repository
 * @param {number} [depth=0] - Maximum recursion depth
 * @returns {Promise<Array<{path: string, content: string|null}>>}
 */
async function getAllRelevantFiles(owner, repo, path = '', depth = 0) {
  if (depth >= 2) {
    return [];
  }

  try {
    const headers = GITHUB_TOKEN ? { Authorization: `token ${GITHUB_TOKEN}` } : {};
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
    const response = await axios.get(apiUrl, { headers });

    const relevantFiles = [];

    for (const item of response.data) {
      if (item.type === 'file' && (item.name.endsWith('.md') || !item.name.includes('.'))) {
        console.log('Relevant File:', item.path);
        // If it's a markdown file or a file without extension, retrieve its content
        const fileContent = await getFileContent(owner, repo, item.path);
        relevantFiles.push({ path: item.path, content: fileContent });
      } else if (item.type === 'dir') {
        // If it's a directory, recursively get relevant files
        const filesInDir = await getAllRelevantFiles(owner, repo, item.path, depth + 1);
        relevantFiles.push(...filesInDir);
      }
    }

    return relevantFiles;
  } catch (error) {
    console.error(`Error retrieving relevant files from ${path}:`, error);
    return [];
  }
}

// Helper function to extract owner and repo name from GitHub URL
/**
 * Parses a GitHub URL to extract the owner and repository name
 * @param {string} url - GitHub repository URL
 * @returns {{owner: string|null, repo: string|null}}
 */
function parseGithubUrl(url) {
  const regex = /https:\/\/github\.com\/([^/]+)\/([^/]+)/;
  const match = url.match(regex);

  if (match) {
    return { owner: match[1], repo: match[2] };
  } else {
    return { owner: null, repo: null };
  }
}
