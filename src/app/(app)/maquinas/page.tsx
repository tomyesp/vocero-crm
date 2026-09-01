import { notFound } from "next/navigation";
import { inventoryEnabled } from "@/server/inventory/flag";
import { MachinesClient } from "@/components/inventory/machines-client";

export const dynamic = "force-dynamic";

export default function MaquinasPage() {
  if (!inventoryEnabled()) notFound();
  return (
    <div className="flex h-full flex-col">
      <header className="border-b px-4 py-3 sm:px-6 sm:py-4">
        <h2 className="font-semibold">Máquinas</h2>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
        <MachinesClient />
      </div>
    </div>
  );
}
