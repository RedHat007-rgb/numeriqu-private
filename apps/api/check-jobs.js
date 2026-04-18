
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function checkJobs() {
  const jobs = await prisma.syncJob.findMany({
    where: { tenantId: 'b56803a9-e705-4f88-9afa-ce66ca758a45' },
    orderBy: { startedAt: 'desc' },
    take: 5
  });
  console.log(JSON.stringify(jobs, null, 2));
  process.exit(0);
}

checkJobs();
