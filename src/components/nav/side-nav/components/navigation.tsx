"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { navigations } from "@/config/site";
import { cn } from "@/lib/utils";

import { BarChart, LineChart, PieChart, AreaChart, ScatterChart, Table } from "lucide-react";

export default function Navigation() {
  const pathname = usePathname();
  return (
    <nav className="flex flex-grow flex-col gap-y-1 p-2">
      {navigations.map((navigation) => {
        const Icon = navigation.icon;
        return (
          <Link
            key={navigation.name}
            href={navigation.href}
            className={cn(
              "flex items-center rounded-md px-2 py-1.5 hover:bg-slate-200 dark:hover:bg-slate-800",
              pathname === navigation.href
                ? "bg-slate-200 dark:bg-slate-800"
                : "bg-transparent",
            )}
          >
            <Icon
              size={16}
              className="mr-2 text-slate-800 dark:text-slate-200"
            />
            <span className="text-sm text-slate-700 dark:text-slate-300">
              {navigation.name}
            </span>
          </Link>
        );
      })}

      <div className="mt-8 px-2 pb-2">
        <h3 className="mb-2 px-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
          Supported Charts
        </h3>
        <div className="flex flex-col gap-y-1">
          {[
            { name: "Bar Chart", icon: BarChart },
            { name: "Line Chart", icon: LineChart },
            { name: "Pie Chart", icon: PieChart },
            { name: "Area Chart", icon: AreaChart },
            { name: "Scatter Plot", icon: ScatterChart },
            { name: "Data Table", icon: Table },
          ].map((chart) => {
            const Icon = chart.icon;
            return (
              <div
                key={chart.name}
                className="flex items-center rounded-md px-2 py-1.5 text-slate-600 dark:text-slate-400"
              >
                <Icon size={16} className="mr-2" />
                <span className="text-sm">{chart.name}</span>
              </div>
            );
          })}
        </div>
      </div>
    </nav>
  );
}
