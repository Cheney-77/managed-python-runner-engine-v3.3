"use strict";
/* Friendly parameter-source controls. Exact request keys/values come from
   Analyze + live OpenAPI; no new server request shape is invented. */
(function installBindingEditor(root) {
  const S = root.SchemaTools;
  const Form = root.FormBuilder;
  const own = (o,k) => Object.prototype.hasOwnProperty.call(o || {},k);
  const normalize = (name) => String(name).replace(/[^a-z0-9]/gi,"").toLowerCase();
  const plain = (v) => !!v && typeof v === "object" && !Array.isArray(v);
  const DOM = (tag,css,text) => {
    const n=document.createElement(tag);
    if(css) n.className=css;
    if(text !== undefined) n.textContent=String(text);
    return n;
  };

  const SOURCE_INFO = Object.freeze({
    "input.payload": {
      title:"输入内容", description:"将当前数据包的内容传给函数", icon:"▤",
    },
    "input.metadata": {
      title:"输入属性", description:"读取数据包中的指定属性", icon:"≡",
    },
    "operator.parameter": {
      title:"算子参数", description:"使用算子运行时配置的参数", icon:"⚙",
    },
    "constant": {
      title:"固定值", description:"每次运行都传入指定的值", icon:"＝",
    },
  });

  const FIELD_LABELS = Object.freeze({
    source:"参数来源", bindingsource:"参数来源", kind:"参数来源",
    key:"属性或参数名称", name:"属性或参数名称",
    attribute:"属性名称", attributekey:"属性名称", attributename:"属性名称",
    metadatakey:"属性名称", metadatafield:"属性名称", metadataname:"属性名称",
    flowfileattribute:"属性名称", flowfileattributename:"属性名称",
    inputattribute:"属性名称", inputattributekey:"属性名称",
    inputmetadatakey:"属性名称", attrkey:"属性名称", metadatapath:"属性路径",
    parameter:"参数名称", parameterkey:"参数名称", parametername:"参数名称",
    operatorparameter:"参数名称", operatorparameterkey:"参数名称",
    operatorparametername:"参数名称", property:"参数名称",
    propertyname:"参数名称",
    constant:"固定值", constantvalue:"固定值", literal:"固定值",
    literalvalue:"固定值", value:"固定值", fixedvalue:"固定值", staticvalue:"固定值",
    valuetype:"值类型", constanttype:"值类型", literaltype:"值类型",
    codec:"内容格式", payloadcodec:"内容格式", contentcodec:"内容格式",
    inputcodec:"内容格式", encoding:"字符编码",
    payloadpath:"内容路径", contentpath:"内容路径",
    jsonpath:"内容路径", fieldpath:"内容路径", selector:"内容路径",
    path:"内容路径",
  });

  const FIELD_GROUPS = Object.freeze({
    attribute:"input.metadata", attributekey:"input.metadata",
    attributename:"input.metadata", metadata:"input.metadata",
    metadatakey:"input.metadata", metadatafield:"input.metadata",
    metadataname:"input.metadata", flowfileattribute:"input.metadata",
    flowfileattributename:"input.metadata",
    inputattribute:"input.metadata", inputattributekey:"input.metadata",
    inputmetadatakey:"input.metadata", attrkey:"input.metadata",
    metadatapath:"input.metadata",
    parameter:"operator.parameter", parameterkey:"operator.parameter",
    parametername:"operator.parameter", operatorparameter:"operator.parameter",
    operatorparameterkey:"operator.parameter",
    operatorparametername:"operator.parameter", property:"operator.parameter",
    propertyname:"operator.parameter",
    constant:"constant", constantvalue:"constant", literal:"constant",
    literalvalue:"constant", fixedvalue:"constant", staticvalue:"constant",
    value:"constant", valuetype:"constant", constanttype:"constant",
    literaltype:"constant",
    payloadpath:"input.payload", contentpath:"input.payload",
    jsonpath:"input.payload", fieldpath:"input.payload",
    selector:"input.payload", codec:"input.payload",
    payloadcodec:"input.payload", inputcodec:"input.payload",
    contentcodec:"input.payload", path:"input.payload",
  });
  function fieldGroup(key,source) {
    const normalized=normalize(key);
    if (own(FIELD_GROUPS,normalized)) return FIELD_GROUPS[normalized];
    // "key"/"name" is ambiguous: often shared by metadata and configured
    // parameters. Do not invent a backend field meaning.
    if (normalized==="key" || normalized==="name")
      return ["input.metadata","operator.parameter"].includes(source)
        ? source : null;
    return null;
  }

  function displaySource(value) {
    return SOURCE_INFO[value] || {title:String(value), description:"", icon:"·"};
  }
  function sourceChoices(schema,doc,allowedSources) {
    const shape=S.flatten(schema,doc);
    const sourceKey=S.sourceField(schema,doc,allowedSources);
    const discriminator=shape.discriminator?.propertyName;
    const variants=Array.isArray(shape.oneOf) ? shape.oneOf
      : Array.isArray(shape.anyOf) ? shape.anyOf : null;

    if (variants?.length) {
      const mapping=new Map();
      let unionKey=discriminator || sourceKey;
      for (const part of variants) {
        const branch=S.flatten(part,doc);
        const props=branch.properties || {};
        const key=unionKey ||
          Object.keys(props).find(k => {
            const values=S.options(props[k],doc);
            return values?.some(v=>allowedSources.includes(v));
          });
        if(!key || !props[key]) continue;
        unionKey=key;
        const values=S.options(props[key],doc) || [];
        for(const value of values) {
          if(allowedSources.includes(value)) mapping.set(value,part);
        }
      }
      if(mapping.size===allowedSources.length && unionKey) {
        return {mode:"union",sourceKey:unionKey,
          allowed:allowedSources.slice(), branches:mapping};
      }
      // If top-level schema is genuinely a pure union with no root
      // properties, do not falsify its shape by making a flat request.
      if(!Object.keys(shape.properties || {}).length) {
        return {mode:"unsupported",allowed:[],sourceKey:null,
          reason:"无法显示此参数的来源选项，请联系管理员。"};
      }
    }
    if(!sourceKey || !own(shape.properties,sourceKey)) {
      return {mode:"unsupported",allowed:[],sourceKey:null,
        reason:"此参数暂时无法配置，请联系管理员。"};
    }
    const values=S.options(shape.properties[sourceKey],doc);
    const choices=values ? allowedSources.filter(v=>values.includes(v))
      : allowedSources.slice();
    if(!choices.length) return {mode:"unsupported",allowed:[],
      sourceKey,reason:"这个参数没有可选的有效来源。"};
    return {mode:"flat",allowed:choices,sourceKey,branches:null};
  }

  function fromSuggestion(suggestion,schema,doc,allowedSources) {
    const plan=sourceChoices(schema,doc,allowedSources);
    if(plan.mode==="unsupported") return null;
    if(plan.mode==="flat") return S.fromSuggestion(
      suggestion,schema,doc,plan.allowed
    );
    const matches=[];
    for(const source of plan.allowed) {
      const candidate=S.fromSuggestion(
        suggestion,plan.branches.get(source),doc,[source]
      );
      if(candidate && (!candidate[plan.sourceKey] ||
        candidate[plan.sourceKey]===source)) {
        matches.push({source,candidate});
      }
    }
    // Without an explicit discriminator, a partial suggestion that fits
    // several branches is ambiguous: don't silently pick the first source.
    if(matches.length!==1) return null;
    return {
      ...matches[0].candidate,
      [plan.sourceKey]:matches[0].source,
    };
  }

  function filterSchema(schema,doc,source,sourceKey) {
    const shape=S.flatten(schema,doc);
    const all=shape.properties || {};
    const required=new Set(shape.required || []);
    const main={}, extra={};
    for(const [name,definition] of Object.entries(all)) {
      if(name===sourceKey) continue;
      const group=fieldGroup(name,source);
      if(group && group!==source) {
        // Required entries in a FLAT schema must be shown for all sources;
        // otherwise we'd omit a key the backend may demand.
        if(required.has(name)) main[name]=definition;
        continue;
      }
      if(required.has(name) || group===source) main[name]=definition;
      else extra[name]=definition;
    }
    return {main, extra, required, additionalProperties:shape.additionalProperties};
  }

  function labelFor(name, schema, doc) {
    const key=normalize(name);
    if(own(FIELD_LABELS,key)) return FIELD_LABELS[key];
    return S.flatten(schema,doc).title || name;
  }

  function valueKindEditor(schema,doc,initial) {
    const s=S.flatten(schema,doc);
    const kind=S.schemaType(s,doc);
    // A fully-typed schema is rendered with its real field type instead.
    if(!["unknown"].includes(kind)) return Form.editor(schema,{
      doc,name:"固定值",initial,
    });
    const rootNode=DOM("div","constant-value-editor");
    const select=DOM("select");
    const options=[
      ["string","文本"],["number","数字"],["boolean","布尔值"],
      ["json","对象或数组"],["null","空值"],
    ];
    for(const [value,label] of options) {
      const opt=DOM("option","",label);
      opt.value=value;
      select.append(opt);
    }
    let mode="string";
    if(initial===null) mode="null";
    else if(typeof initial==="number") mode="number";
    else if(typeof initial==="boolean") mode="boolean";
    else if(plain(initial)||Array.isArray(initial)) mode="json";
    select.value=mode;
    const choice=DOM("div","quick-type");
    choice.append(DOM("span","meta-label","值类型"));
    choice.append(select);
    rootNode.append(choice);
    const holder=DOM("div","quick-value");
    rootNode.append(holder);
    const inputs={};
    const drafts={};
    function refresh() {
      holder.replaceChildren();
      if(select.value==="null") {
        holder.append(DOM("p","field-help","传入空值（null）"));
        return;
      }
      if(select.value==="boolean") {
        const checkbox=DOM("input");checkbox.type="checkbox";
        checkbox.checked=Object.prototype.hasOwnProperty.call(drafts,"boolean")
          ? drafts.boolean : initial===true;
        inputs.boolean=checkbox;
        const row=DOM("label","bool-row");
        row.append(checkbox,DOM("span","","值为 true"));
        holder.append(row);
        return;
      }
      if(select.value==="json") {
        const area=DOM("textarea","json-editor small");
        area.value=Object.prototype.hasOwnProperty.call(drafts,"json")
          ? drafts.json
          : JSON.stringify(plain(initial)||Array.isArray(initial)?initial:{},null,2);
        area.spellcheck=false;
        inputs.json=area;
        holder.append(area);
        holder.append(DOM("small","field-help","输入合法的 JSON 对象或数组"));
        return;
      }
      const input=DOM("input");
      input.type=select.value==="number"?"number":"text";
      if(input.type==="number") input.step="any";
      input.placeholder=select.value==="number"?"例如：42":"输入固定文本";
      const fallback=select.value==="string" && typeof initial==="string" ? initial
        : select.value==="number" && typeof initial==="number" ? String(initial) : "";
      input.value=Object.prototype.hasOwnProperty.call(drafts,select.value)
        ? drafts[select.value] : fallback;
      inputs[select.value]=input;
      holder.append(input);
    }
    select.addEventListener("change",()=>{
      if(mode==="boolean"&&inputs.boolean) drafts.boolean=inputs.boolean.checked;
      if(mode==="json"&&inputs.json) drafts.json=inputs.json.value;
      if(mode==="string"&&inputs.string) drafts.string=inputs.string.value;
      if(mode==="number"&&inputs.number) drafts.number=inputs.number.value;
      mode=select.value;
      refresh();
    });
    refresh();
    return {element:rootNode,read() {
      if(select.value==="null") return null;
      if(select.value==="boolean") return inputs.boolean.checked;
      if(select.value==="string") return inputs.string.value;
      if(select.value==="number") {
        const number=Number(inputs.number.value);
        if(!inputs.number.value.trim() || !Number.isFinite(number))
          throw new Error("请填写有效数字");
        return number;
      }
      let value;
      try {value=JSON.parse(inputs.json.value);}
      catch {throw new Error("固定值必须是合法 JSON");}
      if(!plain(value)&&!Array.isArray(value))
        throw new Error("请选择“文本/数字/布尔值”以填写相应类型");
      return value;
    }};
  }

  // Value data is never inferred from Python annotation alone.
  function makeEditor({schema,doc,allowedSources,parameterName,initial,onUpdate}) {
    const plan=sourceChoices(schema,doc,allowedSources);
    const shell=DOM("div","binding-choice-editor");
    if(plan.mode==="unsupported") {
      shell.append(DOM("div","warning",plan.reason));
      return {element:shell,read:()=>{throw new Error(plan.reason);}};
    }
    const title=DOM("div","binding-source-label","参数来源");
    shell.append(title);
    const picker=DOM("div","source-choice-grid");
    picker.setAttribute("role","radiogroup");
    picker.setAttribute("aria-label",`${parameterName} 参数来源`);
    shell.append(picker);
    const controls=[];
    const groupName=`source-${Math.random().toString(36).slice(2)}`;
    let selected=null;
    let current=null;
    const drafts=new Map();
    for(const value of plan.allowed) {
      const desc=displaySource(value);
      const label=DOM("label","source-choice");
      const radio=DOM("input");
      radio.type="radio";radio.name=groupName;radio.value=value;
      const copy=DOM("span","source-choice-content");
      copy.append(DOM("strong","",desc.title));
      if(desc.description) copy.append(DOM("small","",desc.description));
      label.append(radio,copy);
      picker.append(label);
      controls.push({value,radio,label});
    }
    const help=DOM("p","source-current-hint","");
    shell.append(help);
    const fieldHolder=DOM("div","source-fields");
    shell.append(fieldHolder);

    function branchFor(source) {
      return plan.mode==="union" ? plan.branches.get(source) : schema;
    }
    function draw(source) {
      if(current && selected) {
        try {drafts.set(selected,current.read());}
        catch { /* Keep the last valid draft; incomplete input is not submitted. */ }
      }
      selected=source;
      controls.forEach(({value,radio,label})=>{
        radio.checked=value===source;
        label.classList.toggle("chosen",value===source);
      });
      const info=displaySource(source);
      help.textContent=info.description;
      fieldHolder.replaceChildren();
      const branch=branchFor(source);
      const filtered=filterSchema(branch,doc,source,plan.sourceKey);
      const previous=drafts.get(source) ||
        (plain(initial)&&initial[plan.sourceKey]===source?initial:{});
      const active=[...Object.entries(filtered.main)];
      const extra=[...Object.entries(filtered.extra)];
      const children=new Map();
      const advancedChildren=new Map();
      const mainForm=DOM("div","source-main-fields");
      fieldHolder.append(mainForm);

      function renderProperty([name,definition],destination,store,requiredField) {
        const box=DOM("div","source-property");
        const fieldSchema=S.flatten(definition,doc);
        const title=labelFor(name,definition,doc);
        const group=fieldGroup(name,source);
        const label=DOM("label","source-property-label",title);
        if(requiredField) label.append(DOM("span","required-mark"," *"));
        box.append(label);
        if(fieldSchema.description)
          box.append(DOM("p","source-property-desc",fieldSchema.description));
        const initialValue=own(previous,name)?previous[name]:
          S.template(definition,doc);
        let editor;
        const explicitValueType=Object.keys(S.flatten(branch,doc).properties || {})
          .some(key=>/^(valuetype|constanttype|literaltype)$/.test(normalize(key)));
        if(source==="constant" && !explicitValueType &&
          ["value","constantvalue","literalvalue","fixedvalue"].includes(normalize(name)))
          editor=valueKindEditor(definition,doc,initialValue);
        else editor=Form.editor(definition,{
          doc,name:`${parameterName}.${name}`,initial:initialValue,
        });
        box.append(editor.element);
        const optional=!filtered.required.has(name);
        let checkbox=null;
        if(optional) {
          checkbox=DOM("input"); checkbox.type="checkbox";
          const normalized=normalize(name);
          const isIdentifier=source==="input.metadata"
            ? /^(key|name|attribute|attributekey|attributename|metadatakey|metadataname|inputattribute|inputattributekey|inputmetadatakey|attrkey)$/.test(normalized)
            : source==="operator.parameter"
              ? /^(key|name|parameter|parameterkey|parametername|operatorparameter|operatorparametername|operatorparameterkey|property|propertyname)$/.test(normalized)
              : false;
          const isConstantValue=source==="constant"
            && /^(value|constant|constantvalue|literal|literalvalue|fixedvalue|staticvalue)$/.test(normalized);
          const needsValue=group===source && (isIdentifier || isConstantValue);
          // Do not enable optional codec/path automatically: schema.enum[0]
          // is not a user-approved output/input format.
          checkbox.checked=own(previous,name) || needsValue;
          const toggle=DOM("label","include-property");
          toggle.append(checkbox,DOM("span","","使用此设置"));
          if(needsValue) {
            checkbox.checked=true;
            checkbox.disabled=true;
            toggle.classList.add("hidden");
          }
          box.insertBefore(toggle,editor.element);
          editor.element.classList.toggle("hidden",!checkbox.checked);
          checkbox.addEventListener("change",()=>{
            editor.element.classList.toggle("hidden",!checkbox.checked);
            onUpdate?.();
          });
        }
        store.set(name,{editor,checkbox,required:requiredField});
        destination.append(box);
      }
      for(const entry of active) renderProperty(entry,mainForm,children,
        filtered.required.has(entry[0]));
      if(!active.length) {
        mainForm.append(DOM("div","source-empty","此来源无需额外配置。"));
      }

      if(extra.length || filtered.additionalProperties) {
        const details=DOM("details","source-advanced");
        details.append(DOM("summary","","更多设置"));
        const optionalHost=DOM("div","source-extra-fields");
        for(const entry of extra) renderProperty(
          entry,optionalHost,advancedChildren,false
        );
        let extraArea=null;
        if(filtered.additionalProperties) {
          const box=DOM("div","source-property");
          box.append(DOM("label","source-property-label","自定义字段"));
          extraArea=DOM("textarea","json-editor small");
          const known=new Set([plan.sourceKey,...Object.keys(filtered.main),
            ...Object.keys(filtered.extra)]);
          const extras=Object.fromEntries(Object.entries(previous).filter(
            ([key])=>!known.has(key)
          ));
          extraArea.value=JSON.stringify(extras,null,2);
          box.append(extraArea);
          optionalHost.append(box);
        }
        details.append(optionalHost);
        fieldHolder.append(details);
        if(extra.some(([name])=>own(previous,name))) details.open=true;
        current={read() {
          const body={[plan.sourceKey]:selected};
          const readFields=(fields)=>{
            for(const [name,record] of fields) {
              if(record.checkbox && !record.checkbox.checked) continue;
              body[name]=record.editor.read();
            }
          };
          readFields(children);
          readFields(advancedChildren);
          if(extraArea) {
            let parsed;
            try {parsed=JSON.parse(extraArea.value);}
            catch {throw new Error("自定义字段应填写合法 JSON 对象");}
            if(!plain(parsed)) throw new Error("自定义字段必须是 JSON 对象");
            for(const [key,value] of Object.entries(parsed)) {
              if(own(body,key)) throw new Error(`重复配置字段：${key}`);
              body[key]=value;
            }
          }
          return body;
        }};
      } else {
        current={read() {
          const body={[plan.sourceKey]:selected};
          for(const [name,record] of children) {
            if(record.checkbox && !record.checkbox.checked) continue;
            body[name]=record.editor.read();
          }
          return body;
        }};
      }
      onUpdate?.();
    }

    for(const choice of controls) {
      choice.radio.addEventListener("change",()=>{
        if(choice.radio.checked) draw(choice.value);
      });
    }
    const fromInitial=plain(initial)&&initial[plan.sourceKey];
    if(fromInitial && plan.allowed.includes(fromInitial)) draw(fromInitial);
    // No source is preselected without a real prior choice.
    return {
      element:shell,
      selectSource(source) {
        if(!plan.allowed.includes(source))
          throw new Error("选中的来源未被此参数支持");
        draw(source);
      },
      read() {
        if(!selected || !current)
          throw new Error(`请为「${parameterName}」选择参数来源`);
        const body=current.read();
        // Inactive source fields are excluded by construction.
        return body;
      },
      choices:plan.allowed.slice(),
      getSource:()=>selected,
    };
  }

  const api={
    SOURCE_INFO,FIELD_LABELS,fieldGroup,displaySource,sourceChoices,
    filterSchema,labelFor,valueKindEditor,fromSuggestion,makeEditor,
  };
  root.BindingEditor=api;
  if(typeof module!=="undefined"&&module.exports) module.exports=api;
})(typeof globalThis!=="undefined"?globalThis:this);
