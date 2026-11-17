import { useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";

type Option = { value: string; label: string; detail?: string };
// Official shadcn Combobox composition; model IDs stay separate from display labels.
export function OptionPicker({
  label,
  options,
  values,
  onChange,
  disabled,
  single,
  allowCustom,
  maxCustomLength,
}: {
  label: string;
  options: Option[];
  values: string[];
  onChange: (values: string[]) => void;
  disabled?: boolean;
  single?: boolean;
  allowCustom?: boolean;
  maxCustomLength?: number;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  function select(value: string) {
    onChange(
      single
        ? [value]
        : values.includes(value)
          ? values.filter((v) => v !== value)
          : [...values, value],
    );
    if (single) setOpen(false);
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label={label}
          disabled={disabled}
          className="h-auto min-h-9 w-full justify-between py-2 text-left font-normal"
        >
          <span className="flex min-w-0 flex-1 flex-wrap gap-1">
            {values.length ? (
              values.map((value) => (
                <Badge
                  key={value}
                  variant="secondary"
                  className="max-w-full truncate font-normal"
                  title={value}
                >
                  {options.find((option) => option.value === value)?.label ??
                    value}
                </Badge>
              ))
            ) : (
              <span className="text-muted-foreground">选择{label}</span>
            )}
          </span>
          <ChevronsUpDown className="ml-2 size-4 shrink-0 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[var(--radix-popover-trigger-width)] p-0"
      >
        <Command>
          <CommandInput
            placeholder={`搜索${label}`}
            value={query}
            onValueChange={setQuery}
            maxLength={maxCustomLength}
          />
          <CommandList className="max-h-56">
            <CommandEmpty>没有匹配项</CommandEmpty>
            <CommandGroup>
              {options.map((option) => (
                <CommandItem
                  key={option.value}
                  value={`${option.label} ${option.value}`}
                  onSelect={() => select(option.value)}
                  aria-label={`${option.label}${values.includes(option.value) ? "，已勾选" : "，未勾选"}`}
                >
                  <Check
                    className={
                      values.includes(option.value)
                        ? "opacity-100"
                        : "opacity-0"
                    }
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block break-all">{option.label}</span>
                    {option.detail && (
                      <span className="block truncate text-xs text-muted-foreground">
                        {option.detail}
                      </span>
                    )}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
          {allowCustom &&
            query.trim() &&
            !options.some((option) => option.value === query.trim()) && (
              <Button
                type="button"
                variant="ghost"
                className="m-1 h-auto justify-start whitespace-normal"
                onClick={() => {
                  select(query.trim());
                  setQuery("");
                }}
              >
                添加理由：{query.trim()}
              </Button>
            )}
        </Command>
      </PopoverContent>
    </Popover>
  );
}
