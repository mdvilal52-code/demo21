-- CreateEnum
CREATE TYPE "MissingInfoStatus" AS ENUM ('AWAITING_CUSTOMER', 'COMPLETE');

-- CreateTable
CREATE TABLE "missing_information_states" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "status" "MissingInfoStatus" NOT NULL,
    "answers" JSONB NOT NULL,
    "askedFieldKeys" TEXT[],
    "pendingQuestions" JSONB NOT NULL,
    "corrections" JSONB NOT NULL,
    "contradictions" JSONB NOT NULL,
    "flags" JSONB NOT NULL,
    "turnCount" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "missing_information_states_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "missing_information_states_conversationId_key" ON "missing_information_states"("conversationId");

-- CreateIndex
CREATE INDEX "missing_information_states_tenantId_idx" ON "missing_information_states"("tenantId");

-- AddForeignKey
ALTER TABLE "missing_information_states" ADD CONSTRAINT "missing_information_states_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "missing_information_states" ADD CONSTRAINT "missing_information_states_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
