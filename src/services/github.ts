/// <reference types="vite/client" />

const getHeaders = () => {
  const token = import.meta.env.VITE_GITHUB_TOKEN;
  return token ? { Authorization: `token ${token}` } : {};
};

export const fetchRepoTree = async (repoUrl: string, branch: string = 'main') => {
  const [owner, repo] = extractOwnerRepo(repoUrl);
  if (!owner || !repo) throw new Error("Invalid GitHub URL");

  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`, {
    headers: getHeaders()
  });
  if (!response.ok) throw new Error("Failed to fetch repo tree");
  
  const data = await response.json();
  return data.tree; // Array of { path, mode, type, sha, url }
};

export const fetchFileContent = async (repoUrl: string, path: string) => {
  const [owner, repo] = extractOwnerRepo(repoUrl);
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${path}`, {
    headers: getHeaders()
  });
  if (!response.ok) throw new Error("Failed to fetch file content");
  
  const data = await response.json();
  // content is base64 encoded
  const binaryString = atob(data.content);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
};

const extractOwnerRepo = (url: string) => {
  try {
    const urlObj = new URL(url);
    const parts = urlObj.pathname.split('/').filter(Boolean);
    if (parts.length >= 2) {
      return [parts[0], parts[1]];
    }
  } catch (e) {
    // maybe it's just owner/repo format
    const parts = url.split('/').filter(Boolean);
    if (parts.length === 2) return parts;
  }
  return [null, null];
};
