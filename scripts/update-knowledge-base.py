"""
PitchPrfct Knowledge Base Auto-Updater

Pulls the latest AIDialer codebase, extracts support-relevant documentation
from key files, generates embeddings, and upserts into the Neon pgvector DB.

Designed to run weekly via GitHub Actions or any cron scheduler.

Environment variables required:
  NEON_API_KEY        — Neon API key for password retrieval
  NEON_PROJECT_ID     — Neon project ID (default: autumn-sound-83308762)
  NEON_BRANCH_ID      — Neon branch ID (default: br-proud-mountain-a5ylsqno)
  NEON_ENDPOINT       — Neon host (default: ep-broad-firefly-a5jkth1v.us-east-2.aws.neon.tech)
  GITHUB_TOKEN        — For cloning private repos (provided by GitHub Actions automatically)
"""

import os
import re
import json
import subprocess
import urllib.request
import ssl
import tempfile
import hashlib
from pathlib import Path

# ── Config ──
NEON_API_KEY = os.environ.get("NEON_API_KEY", "")
NEON_PROJECT_ID = os.environ.get("NEON_PROJECT_ID", "autumn-sound-83308762")
NEON_BRANCH_ID = os.environ.get("NEON_BRANCH_ID", "br-proud-mountain-a5ylsqno")
NEON_ENDPOINT = os.environ.get("NEON_ENDPOINT", "ep-broad-firefly-a5jkth1v.us-east-2.aws.neon.tech")
REPO_URL = os.environ.get("REPO_URL", "https://github.com/rchvalbo/AIDialer.git")
EMBEDDING_MODEL = "all-MiniLM-L6-v2"
EMBEDDING_DIM = 384

# Files to extract knowledge from (path relative to repo root)
# Grouped by domain for metadata tagging
EXTRACTION_MAP = {
    "message_pipeline": [
        "server/services/messageSendingService.ts",
        "server/services/messageBatchProcessor.ts",
        "server/services/scheduler/handlers/smsTaskHandler.ts",
        "server/services/scheduler/handlers/campaignBatchHandler.ts",
        "server/services/campaign/campaign-preparation.ts",
        "server/services/scheduler/workers/sms-v2/services/send.service.ts",
        "server/services/scheduler/workers/sms-v2/services/preparation.service.ts",
        "server/services/textgrid.ts",
        "server/services/MessageProviderService.ts",
        "server/queues/index.ts",
    ],
    "workflows": [
        "server/services/workflowService.ts",
        "server/services/workflowExecution.ts",
        "server/services/workflowProgressService.ts",
        "server/services/scheduler/workflow/workflowStateManager.ts",
        "server/services/scheduler/workflow/bulkWorkflowProcessor.ts",
        "server/services/scheduler/enrollment/enrollmentCompletionService.ts",
    ],
    "credits_payments": [
        "server/services/creditService.ts",
        "server/services/payments.ts",
        "server/services/rechargeFailureCache.ts",
        "server/errors/creditError.ts",
        "server/errors/paymentError.ts",
    ],
    "system_pause": [
        "server/services/SystemPauseService.ts",
        "server/services/carrierBlockAutomationService.ts",
    ],
    "10dlc_compliance": [
        "server/services/10dlc-diagnostic-service.ts",
        "server/services/10dlc-trial-checker.ts",
        "server/services/ai/10dlcComplianceService.ts",
        "server/services/brandVerificationService.ts",
        "server/errors/brandError.ts",
        "server/errors/campaignError.ts",
        "server/errors/vettingError.ts",
    ],
    "contacts_import": [
        "server/services/contactImportService.ts",
        "server/services/contactValidationService.ts",
        "server/services/PhoneScrubbingService.ts",
        "server/services/LandlineRemoverService.ts",
        "server/services/TcpaLitigatorListService.ts",
        "server/services/phoneNumberService.ts",
    ],
    "schemas_config": [
        "shared/schema/auth/schema.ts",
        "shared/schema/auth/credits.ts",
        "shared/schema/auth/systemPauses.ts",
        "shared/schema/campaigns/schema.ts",
        "shared/schema/contacts/schema.ts",
        "shared/schema/10dlc/schema.ts",
        "shared/schema/10dlc/types.ts",
        ".env.example",
        "ecosystem.config.cjs",
    ],
    "documentation": [
        "CLAUDE.md",
        "docs/payment-recovery-system.md",
        "docs/carrier-block-detection.md",
        "docs/phone-scrubbing-system.md",
        "docs/system-pause-resume.md",
        "docs/BUGFIX-WORKFLOW-CLOGGING.md",
        "docs/REDIS-ARCHITECTURE.md",
        "docs/SMS_WORKER_V2_ARCHITECTURE.md",
    ],
}


def get_db_password():
    url = f"https://console.neon.tech/api/v2/projects/{NEON_PROJECT_ID}/branches/{NEON_BRANCH_ID}/roles/neondb_owner/reveal_password"
    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {NEON_API_KEY}",
        "Content-Type": "application/json"
    })
    ctx = ssl.create_default_context()
    with urllib.request.urlopen(req, context=ctx) as resp:
        return json.loads(resp.read())["password"]


def clone_repo(target_dir):
    """Clone or pull the latest code."""
    token = os.environ.get("GITHUB_TOKEN", "")
    repo_url = REPO_URL
    if token and "github.com" in repo_url:
        repo_url = repo_url.replace("https://", f"https://x-access-token:{token}@")

    if os.path.exists(os.path.join(target_dir, ".git")):
        print(f"Pulling latest in {target_dir}...")
        subprocess.run(["git", "pull", "--ff-only"], cwd=target_dir, capture_output=True)
    else:
        print(f"Cloning {REPO_URL} to {target_dir}...")
        subprocess.run(["git", "clone", "--depth", "1", repo_url, target_dir], capture_output=True)


def extract_file_content(filepath):
    """Read a file and return its content."""
    try:
        with open(filepath, "r", errors="replace") as f:
            return f.read()
    except FileNotFoundError:
        return None


def chunk_file(content, filepath, domain, max_chunk_size=2500):
    """Split a file into semantic chunks based on function/class/section boundaries."""
    chunks = []
    filename = os.path.basename(filepath)

    # For TypeScript files, split on function/class/export boundaries
    if filepath.endswith((".ts", ".mts", ".js", ".mjs")):
        # Split on major boundaries
        sections = re.split(
            r'\n(?=(?:export |async |public |private |protected )?(?:function |class |const \w+ = async |interface ))',
            content
        )
        current = []
        current_len = 0
        for section in sections:
            if current_len + len(section) > max_chunk_size and current:
                chunks.append("\n".join(current))
                current = [section]
                current_len = len(section)
            else:
                current.append(section)
                current_len += len(section)
        if current:
            chunks.append("\n".join(current))

    # For markdown, split on ## headers
    elif filepath.endswith(".md"):
        sections = re.split(r'\n(?=## )', content)
        current = []
        current_len = 0
        for section in sections:
            if current_len + len(section) > max_chunk_size and current:
                chunks.append("\n".join(current))
                current = [section]
                current_len = len(section)
            else:
                current.append(section)
                current_len += len(section)
        if current:
            chunks.append("\n".join(current))

    # For other files, split on double newlines
    else:
        paragraphs = content.split("\n\n")
        current = []
        current_len = 0
        for para in paragraphs:
            if current_len + len(para) > max_chunk_size and current:
                chunks.append("\n\n".join(current))
                current = [para]
                current_len = len(para)
            else:
                current.append(para)
                current_len += len(para)
        if current:
            chunks.append("\n\n".join(current))

    # Add metadata context to each chunk
    result = []
    for i, chunk_text in enumerate(chunks):
        if len(chunk_text.strip()) < 50:
            continue
        # Prepend file context so the embedding captures where this came from
        contextualized = f"[Source: {filename} | Domain: {domain}]\n\n{chunk_text}"
        result.append({
            "content": contextualized[:5000],  # Cap at 5000 chars for embedding
            "raw_content": chunk_text[:5000],
            "domain": domain,
            "section": filename,
            "subsection": f"chunk_{i+1}",
            "source_file": filepath,
        })

    return result


def classify_chunk(content):
    cl = content.lower()
    if any(kw in cl for kw in ["error code", "error_code", "errortype", "throw new", "error("]):
        return "error_code"
    if any(kw in cl for kw in ["step 1", "step 2", "→", "flow:", "pipeline", "async function"]):
        return "flow"
    if any(kw in cl for kw in ["diagnos", "symptom", "root cause", "troubleshoot"]):
        return "diagnostic"
    if any(kw in cl for kw in ["env", "config", "threshold", "redis", "queue", "cron"]):
        return "config"
    if any(kw in cl for kw in ["select ", "from ", "where ", "create table", "schema"]):
        return "sql_query"
    return "concept"


def extract_symptoms(content):
    symptoms = []
    phrases = [
        "blast not sending", "messages not sending", "campaign stuck", "campaign failed",
        "credits disappeared", "insufficient credits", "account paused", "system paused",
        "auto-recharge", "delivery rate", "phone not compliant", "number not compliant",
        "10dlc stuck", "registration failed", "import stuck", "upload failed",
        "workflow not triggering", "ghost drip", "double charged", "card declined",
        "messages failed", "workflow paused", "contacts not entering", "skipped message",
        "payment failed", "recharge failed", "carrier block", "opt-out",
        "not delivering", "stuck", "paused", "failed"
    ]
    cl = content.lower()
    for phrase in phrases:
        if phrase in cl:
            symptoms.append(phrase)
    return list(set(symptoms)) if symptoms else None


def extract_error_codes(content):
    codes = set()
    patterns = [r'`([A-Z][A-Z_]{2,})`', r"'([A-Z][A-Z_]{2,})'", r'"([A-Z][A-Z_]{2,})"']
    for pattern in patterns:
        codes.update(re.findall(pattern, content))
    exclude = {'NULL', 'TRUE', 'FALSE', 'TEXT', 'NOTE', 'TODO', 'ARRAY', 'BEGIN',
               'WHERE', 'SELECT', 'FROM', 'INTO', 'CREATE', 'TABLE', 'INDEX',
               'INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'COMMIT', 'SET'}
    codes = {c for c in codes if len(c) > 3 and c not in exclude}
    return list(codes) if codes else None


def content_hash(content):
    return hashlib.sha256(content.encode()).hexdigest()[:16]


def main():
    import psycopg2
    from sentence_transformers import SentenceTransformer

    if not NEON_API_KEY:
        print("ERROR: NEON_API_KEY required")
        return

    # Clone/pull repo
    repo_dir = os.environ.get("REPO_DIR", "/tmp/AIDialer")
    clone_repo(repo_dir)

    # Extract chunks from all mapped files
    all_chunks = []
    for domain, files in EXTRACTION_MAP.items():
        for rel_path in files:
            filepath = os.path.join(repo_dir, rel_path)
            content = extract_file_content(filepath)
            if content is None:
                print(f"  SKIP (not found): {rel_path}")
                continue
            chunks = chunk_file(content, rel_path, domain)
            print(f"  {rel_path}: {len(chunks)} chunks")
            all_chunks.extend(chunks)

    print(f"\nTotal chunks from codebase: {len(all_chunks)}")

    # Classify and enrich
    for chunk in all_chunks:
        chunk["chunk_type"] = classify_chunk(chunk["content"])
        chunk["symptoms"] = extract_symptoms(chunk["content"])
        chunk["error_codes"] = extract_error_codes(chunk["content"])
        chunk["hash"] = content_hash(chunk["raw_content"])

    # Generate embeddings
    print(f"\nLoading embedding model ({EMBEDDING_MODEL})...")
    model = SentenceTransformer(EMBEDDING_MODEL)

    print("Generating embeddings...")
    texts = [c["content"] for c in all_chunks]
    embeddings = model.encode(texts, show_progress_bar=True, batch_size=32)
    print(f"Generated {len(embeddings)} embeddings")

    # Connect to DB
    password = get_db_password()
    conn = psycopg2.connect(
        host=NEON_ENDPOINT, user="neondb_owner", password=password,
        dbname="support_brain", sslmode="require"
    )
    cur = conn.cursor()

    # Delete only auto-extracted chunks (preserve manual knowledge updates)
    cur.execute("DELETE FROM knowledge_chunks WHERE source_file NOT LIKE 'manual_%' AND source_file != ''")
    deleted = cur.rowcount
    print(f"\nDeleted {deleted} old auto-extracted chunks (manual entries preserved)")

    # Insert new chunks
    insert_sql = """
        INSERT INTO knowledge_chunks
        (content, domain, section, subsection, chunk_type, customer_symptoms, error_codes, embedding, source_file)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s::vector, %s)
    """

    inserted = 0
    for i, chunk in enumerate(all_chunks):
        emb = embeddings[i].tolist()
        emb_str = "[" + ",".join(str(x) for x in emb) + "]"
        try:
            cur.execute(insert_sql, (
                chunk["raw_content"],
                chunk["domain"],
                chunk["section"],
                chunk["subsection"],
                chunk["chunk_type"],
                chunk.get("symptoms"),
                chunk.get("error_codes"),
                emb_str,
                chunk["source_file"],
            ))
            inserted += 1
        except Exception as e:
            print(f"  Error on chunk {i}: {e}")
            conn.rollback()
            continue

    conn.commit()

    # Verify
    cur.execute("SELECT count(*) FROM knowledge_chunks")
    total = cur.fetchone()[0]
    cur.execute("SELECT count(*) FROM knowledge_chunks WHERE source_file LIKE 'manual_%'")
    manual = cur.fetchone()[0]
    cur.execute("SELECT domain, count(*) FROM knowledge_chunks GROUP BY domain ORDER BY count DESC")
    domains = cur.fetchall()

    print(f"\n{'='*50}")
    print(f"KNOWLEDGE BASE UPDATE COMPLETE")
    print(f"{'='*50}")
    print(f"Auto-extracted chunks: {inserted}")
    print(f"Manual knowledge entries: {manual} (preserved)")
    print(f"Total chunks: {total}")
    print(f"\nBy domain:")
    for domain, count in domains:
        print(f"  {domain}: {count}")

    cur.close()
    conn.close()


if __name__ == "__main__":
    main()
