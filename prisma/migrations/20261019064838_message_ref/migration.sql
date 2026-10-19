-- CreateTable
CREATE TABLE "MessageRef" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "messageJobId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageRef_pkey" PRIMARY KEY ("id")
);
