"""Minimal ONNX protobuf reader/writer (no onnx/protobuf dependency) — just enough to inspect a graph and
splice nodes. Messages are kept as lists of (field_number, wire_type, value) so unknown fields survive a
round trip byte-for-byte.

Field numbers (onnx.proto3):
  ModelProto: ir_version 1, opset_import 8 (OperatorSetIdProto: domain 1, version 2), graph 7
  GraphProto: node 1, name 2, initializer 5, input 11, output 12, value_info 13
  NodeProto:  input 1, output 2, name 3, op_type 4, attribute 5, domain 7
  AttributeProto: name 1, f 2, i 3, s 4, t 5, g 6, floats 7, ints 8, strings 9, type 20
  TensorProto: dims 1, data_type 2, float_data 4, int32_data 5, string_data 6, int64_data 7, name 8, raw_data 9, double_data 10
"""
import struct

FLOAT, INT64, INT32, BOOL, DOUBLE = 1, 7, 6, 9, 11


def read_varint(b, i):
    r = 0; s = 0
    while True:
        c = b[i]; i += 1
        r |= (c & 0x7f) << s
        if c < 0x80:
            return r, i
        s += 7


def write_varint(v):
    out = bytearray()
    while True:
        c = v & 0x7f; v >>= 7
        if v:
            out.append(c | 0x80)
        else:
            out.append(c); return bytes(out)


def parse(b):
    """bytes → list of (field, wiretype, value); value is int for varint/fixed, bytes for length-delimited."""
    fields = []; i = 0; n = len(b)
    while i < n:
        key, i = read_varint(b, i)
        f, wt = key >> 3, key & 7
        if wt == 0:
            v, i = read_varint(b, i)
        elif wt == 1:
            v = b[i:i + 8]; i += 8
        elif wt == 2:
            ln, i = read_varint(b, i); v = b[i:i + ln]; i += ln
        elif wt == 5:
            v = b[i:i + 4]; i += 4
        else:
            raise ValueError(f"unsupported wire type {wt}")
        fields.append((f, wt, v))
    return fields


def serialize(fields):
    out = bytearray()
    for f, wt, v in fields:
        out += write_varint((f << 3) | wt)
        if wt == 0:
            out += write_varint(v)
        elif wt == 2:
            out += write_varint(len(v)); out += v
        else:
            out += v
    return bytes(out)


def get(fields, f):
    return [v for (ff, wt, v) in fields if ff == f]


def get1(fields, f, default=None):
    vals = get(fields, f)
    return vals[0] if vals else default


def set1(fields, f, wt, v):
    """replace the first occurrence of field f (or append)."""
    for k, (ff, wtt, vv) in enumerate(fields):
        if ff == f:
            fields[k] = (f, wt, v); return fields
    fields.append((f, wt, v)); return fields


def s(b):
    return b.decode('utf-8')


class Node:
    def __init__(self, raw=None):
        self.fields = parse(raw) if raw is not None else []

    @property
    def inputs(self): return [s(v) for v in get(self.fields, 1)]

    @property
    def outputs(self): return [s(v) for v in get(self.fields, 2)]

    @property
    def name(self): return s(get1(self.fields, 3, b''))

    @property
    def op_type(self): return s(get1(self.fields, 4, b''))

    def attrs(self):
        out = {}
        for a in get(self.fields, 5):
            af = parse(a); nm = s(get1(af, 1, b'')); t = get1(af, 20, 0)
            if t == 1: out[nm] = struct.unpack('<f', get1(af, 2))[0]
            elif t == 2: out[nm] = get1(af, 3)
            elif t == 3: out[nm] = s(get1(af, 4))
            elif t == 4: out[nm] = Tensor(get1(af, 5))
            elif t == 6: out[nm] = [struct.unpack('<f', v)[0] for v in get(af, 7)]
            elif t == 7: out[nm] = get(af, 8)
            elif t == 8: out[nm] = [s(v) for v in get(af, 9)]
            else: out[nm] = ('type', t)
        return out

    def set_inputs(self, names):
        self.fields = [x for x in self.fields if x[0] != 1] + [(1, 2, n.encode()) for n in names]
        return self

    def set_outputs(self, names):
        self.fields = [x for x in self.fields if x[0] != 2] + [(2, 2, n.encode()) for n in names]
        return self

    def serialize(self): return serialize(self.fields)

    def __repr__(self): return f"{self.op_type}({self.name}) {self.inputs} -> {self.outputs}"


def make_attr(name, value):
    f = [(1, 2, name.encode())]
    if isinstance(value, float):
        f += [(2, 5, struct.pack('<f', value)), (20, 0, 1)]
    elif isinstance(value, int):
        f += [(3, 0, value), (20, 0, 2)]
    elif isinstance(value, str):
        f += [(4, 2, value.encode()), (20, 0, 3)]
    elif isinstance(value, list) and all(isinstance(v, int) for v in value):
        f += [(8, 0, v) for v in value] + [(20, 0, 7)]
    elif isinstance(value, Tensor):
        f += [(5, 2, value.serialize()), (20, 0, 4)]
    else:
        raise TypeError(type(value))
    return serialize(f)


def make_node(op_type, inputs, outputs, name, **attrs):
    n = Node()
    n.fields = [(1, 2, i.encode()) for i in inputs] + [(2, 2, o.encode()) for o in outputs] + [(3, 2, name.encode()), (4, 2, op_type.encode())]
    n.fields += [(5, 2, make_attr(k, v)) for k, v in attrs.items()]
    return n


class Tensor:
    def __init__(self, raw=None):
        self.fields = parse(raw) if raw is not None else []

    @property
    def name(self): return s(get1(self.fields, 8, b''))

    @property
    def dims(self): return get(self.fields, 1)

    @property
    def data_type(self): return get1(self.fields, 2, 0)

    def values(self):
        """small tensors only"""
        import numpy as np
        dt = self.data_type; raw = get1(self.fields, 9)
        if raw is not None:
            np_t = {FLOAT: np.float32, INT64: np.int64, INT32: np.int32, BOOL: np.bool_, DOUBLE: np.float64}[dt]
            return np.frombuffer(raw, dtype=np_t).reshape(self.dims if self.dims else ())
        if dt == FLOAT:
            return np.array([struct.unpack('<f', v)[0] for v in get(self.fields, 4)], np.float32).reshape(self.dims if self.dims else ())
        if dt == INT64:
            return np.array([(v - (1 << 64)) if v >= (1 << 63) else v for v in get(self.fields, 7)], np.int64).reshape(self.dims if self.dims else ())
        if dt == INT32:
            return np.array(get(self.fields, 5), np.int32).reshape(self.dims if self.dims else ())
        raise NotImplementedError(dt)

    def serialize(self): return serialize(self.fields)


def make_tensor(name, np_array):
    import numpy as np
    arr = np.ascontiguousarray(np_array)
    dt = {np.dtype('float32'): FLOAT, np.dtype('int64'): INT64, np.dtype('int32'): INT32, np.dtype('bool'): BOOL, np.dtype('float64'): DOUBLE}[arr.dtype]
    t = Tensor()
    t.fields = [(1, 0, int(d)) for d in arr.shape] + [(2, 0, dt), (8, 2, name.encode()), (9, 2, arr.tobytes())]
    return t


class Model:
    def __init__(self, path):
        with open(path, 'rb') as f:
            self.raw = f.read()
        self.fields = parse(self.raw)
        self.graph_fields = parse(get1(self.fields, 7))
        self.nodes = [Node(v) for v in get(self.graph_fields, 1)]
        self.initializers = [Tensor(v) for v in get(self.graph_fields, 5)]

    @property
    def opsets(self):
        out = []
        for v in get(self.fields, 8):
            f = parse(v); out.append((s(get1(f, 1, b'')), get1(f, 2, 0)))
        return out

    def initializer(self, name):
        for t in self.initializers:
            if t.name == name:
                return t
        return None

    def producers(self):
        return {o: n for n in self.nodes for o in n.outputs}

    def consumers(self, name):
        return [n for n in self.nodes if name in n.inputs]

    def graph_outputs(self):
        return [s(get1(parse(v), 1, b'')) for v in get(self.graph_fields, 12)]

    def graph_inputs(self):
        return [s(get1(parse(v), 1, b'')) for v in get(self.graph_fields, 11)]

    def prune(self):
        """drop nodes that do not contribute to any graph output."""
        needed = set(self.graph_outputs()); prod = self.producers(); keep = set()
        stack = list(needed)
        while stack:
            t = stack.pop()
            n = prod.get(t)
            if n is None or id(n) in keep:
                continue
            keep.add(id(n)); stack.extend(n.inputs)
        before = len(self.nodes)
        self.nodes = [n for n in self.nodes if id(n) in keep]
        return before - len(self.nodes)

    def save(self, path):
        gf = [x for x in self.graph_fields if x[0] not in (1, 5)]
        # keep original ordering: nodes first (field 1), then the rest, initializers (5) in place
        nodes = [(1, 2, n.serialize()) for n in self.nodes]
        inits = [(5, 2, t.serialize()) for t in self.initializers]
        # ONNX requires topological order of nodes; preserve list order
        new_graph = nodes + [x for x in gf if x[0] == 2] + inits + [x for x in gf if x[0] not in (2,)]
        mf = [x for x in self.fields if x[0] != 7]
        # graph is field 7; put it where it was (after ir_version/producer fields)
        mf = set1(mf, 7, 2, serialize(new_graph))
        with open(path, 'wb') as f:
            f.write(serialize(mf))
