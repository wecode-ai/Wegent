# Wegent Evaluate

RAG (Retrieval-Augmented Generation) Evaluation Service for automatic quality assessment and analysis.

## Features

- **Data Synchronization**: Automatically fetch historical conversation data from external APIs
- **RAGAS Evaluation**: Evaluate RAG responses using Faithfulness, Answer Relevancy, and Context Precision metrics
- **LLM Analysis**: Deep analysis and improvement suggestions using large language models
- **Analytics Dashboard**: Visualize trends, compare retrievers/embeddings, and analyze issues
- **Scheduled Tasks**: Automated daily sync and evaluation tasks

## Tech Stack

### Backend
- FastAPI + SQLAlchemy + MySQL
- APScheduler for scheduled tasks
- RAGAS >= 0.2.0 for evaluation
- LangChain for LLM integration

### Frontend
- Next.js 15 + React 19 + TypeScript
- shadcn/ui + Tailwind CSS
- Recharts for data visualization

## Quick Start
d
### Using Docker Compose

1. Copy environment file:
```bash
cp .env.example .env
# Edit .env with your configuration
```

2. Start all services:
```bash
docker-compose up -d
```

3. Access the application:
- Frontend: http://localhost:3000
- Backend API: http://localhost:8000

### Manual Setup

#### Backend

```bash
cd backend
# Install dependencies
pip install uv
uv pip install -e .

# Run database migrations
uv run alembic upgrade head

# Start the server
uv run uvicorn main:app --reload
```

#### Frontend

```bash
cd frontend
npm install
npm run dev
```

## Configuration

See `.env.example` for all available configuration options:

- **Database**: MySQL connection settings
- **External API**: OAuth 2.0 credentials for data sync
- **RAGAS**: LLM and embedding model configuration
- **Scheduled Tasks**: Cron expressions for automation

## API Endpoints

### Sync
- `POST /api/sync/trigger` - Trigger data synchronization
- `GET /api/sync/status/{sync_id}` - Get sync job status
- `GET /api/sync/history` - Get sync history

### Evaluation
- `POST /api/evaluation/trigger` - Trigger evaluation job
- `GET /api/evaluation/status/{job_id}` - Get evaluation status
- `GET /api/evaluation/results` - List evaluation results
- `GET /api/evaluation/results/{id}` - Get evaluation detail
- `GET /api/evaluation/summary` - Get evaluation summary

### Analytics
- `GET /api/analytics/trends` - Get score trends
- `GET /api/analytics/comparison/retriever` - Compare retrievers
- `GET /api/analytics/comparison/embedding` - Compare embeddings
- `GET /api/analytics/comparison/context/{id}` - Compare by context
- `GET /api/analytics/issues` - Get issue analytics

## Metrics

### RAGAS Evaluation Metrics

- **Faithfulness** (0-1): Measures how faithful the answer is to the retrieved context
- **Answer Relevancy** (0-1): Measures how relevant the answer is to the question
- **Context Precision** (0-1): Measures the quality of retrieved context

### Issue Types

- `retrieval_miss`: Retrieved content doesn't match the query
- `retrieval_irrelevant`: Retrieved content is irrelevant
- `answer_hallucination`: Answer contains information not in context
- `answer_incomplete`: Answer doesn't fully utilize context
- `answer_irrelevant`: Answer doesn't address the question
- `knowledge_gap`: Knowledge base lacks relevant content

## License

Apache-2.0
