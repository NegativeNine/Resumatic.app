import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SkillDurationClaim, SkillYearsView } from "../../src/shared/skill-years";
import { api } from "../../src/web/api";
import { SkillDurationChoices, SkillYearsPanel } from "../../src/web/components/SkillYears";
import { fixtures } from "./fixtures";
import { renderWithSession } from "./render";

afterEach(()=>vi.restoreAllMocks());
function me(enabled=true) { const me=fixtures().me; me.capabilities={ocr:false,connectedApps:false,skillYears:enabled};return me; }
const claim:SkillDurationClaim={id:"claim",factId:"backing",skillKey:"fact:go",label:"Go",text:"Go — at least 3 years of use, confirmed as of 2026-11",asOf:"2026-11",bounds:{lowerMonths:36,upperMonths:60,precision:"year"},inputHash:"a".repeat(64),confirmedAt:1,current:true,private:false};
function data():SkillYearsView {return{subjects:[{ref:{kind:"fact",id:"go"},label:"Go",key:"fact:go",anchor:"current",private:false}],intervals:[],claims:[],asOf:"2026-11"};}

describe("owner-confirmed skill period controls",()=>{
  it("takes explicit dates without role defaults, previews before confirmation, and never auto-creates a total",async()=>{
    const state=data(); vi.spyOn(api,"skillYears").mockImplementation(async()=>structuredClone(state));
    const save=vi.spyOn(api,"saveSkillInterval").mockImplementation(async(input)=>{state.intervals.push({...input,id:"period",subject:state.subjects[0]!,revision:1,state:"confirmed",createdAt:1});return{id:"period"};});
    const preview=vi.spyOn(api,"previewSkillDuration").mockResolvedValue({...claim,private:false});
    const confirm=vi.spyOn(api,"confirmSkillDuration").mockImplementation(async()=>{state.claims.push(claim);return claim;});
    renderWithSession(<SkillYearsPanel/>,me()); const user=userEvent.setup();
    const start=await screen.findByRole("textbox",{name:"First use (YYYY or YYYY-MM)"}); expect(start).toHaveValue("");
    await user.selectOptions(screen.getByRole("combobox"),"fact:go");
    await user.type(start,"2020");await user.type(screen.getByRole("textbox",{name:"Last use (YYYY or YYYY-MM)"}),"2024");
    await user.click(screen.getByRole("button",{name:"Confirm this period"}));
    await waitFor(()=>expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]![0]).toEqual({subject:{kind:"fact",id:"go"},start:"2020",end:"2024",ongoing:false,private:false});
    expect(save.mock.calls[0]![1]).toMatch(/^[a-f0-9-]{36}$/); expect(preview).not.toHaveBeenCalled();expect(confirm).not.toHaveBeenCalled();
    await screen.findByText("Go: 2020 to 2024"); await user.click(screen.getByRole("button",{name:"Preview total for chosen skill"}));
    expect(await screen.findByText(claim.text)).toBeInTheDocument(); expect(confirm).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button",{name:"Confirm this exact total"}));await waitFor(()=>expect(confirm).toHaveBeenCalledTimes(1));
    expect(confirm.mock.calls[0]![0]).toEqual({kind:"fact",id:"go"}); expect(confirm.mock.calls[0]![1].inputHash).toBe(claim.inputHash);
  });
  it("offers public current totals only, begins unselected, and performs no request while disabled",async()=>{
    const state=data();state.claims=[claim,{...claim,id:"private",private:true},{...claim,id:"old",current:false}];
    const read=vi.spyOn(api,"skillYears").mockResolvedValue(state);
    function Choices(){const[selected,setSelected]=useState<string[]>([]);return <SkillDurationChoices selected={selected} onChange={setSelected} disabled={false}/>;}
    const off=renderWithSession(<Choices/>,me(false));expect(read).not.toHaveBeenCalled();off.unmount();
    renderWithSession(<Choices/>,me());const checkbox=await screen.findByRole("checkbox",{name:claim.text}); expect(checkbox).not.toBeChecked();expect(screen.getAllByRole("checkbox")).toHaveLength(1);
    fireEvent.click(checkbox);expect(checkbox).toBeChecked();
  });
});
